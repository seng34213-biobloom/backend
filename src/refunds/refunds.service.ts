import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OrderStatus, PaymentStatus, RefundStatus, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { InventoryService } from '../inventory/inventory.service';
import { PaymentsService } from '../payments/payments.service';
import { OrderStatusService } from '../orders/order-status.service';
import { NotificationsService } from '../notifications/notifications.service';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import type { CreateRefundRequestDto } from './dto/refund-request.dto';

@Injectable()
export class RefundsService {
  private readonly logger = new Logger(RefundsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly inventory: InventoryService,
    private readonly payments: PaymentsService,
    private readonly orderStatus: OrderStatusService,
    private readonly notifications: NotificationsService,
  ) {}

  async requestRefund(customerId: string, orderId: string, dto: CreateRefundRequestDto) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, status: true, totalAmount: true, customerId: true },
    });
    if (!order) throw new NotFoundException(`Order ${orderId} not found`);
    if (order.customerId !== customerId) throw new ForbiddenException('Not your order');
    if (order.status !== OrderStatus.DELIVERED) {
      throw new BadRequestException(
        `Refunds are only allowed for DELIVERED orders (this one is ${order.status})`,
      );
    }

    const orderTotal = Number(order.totalAmount);
    const amount = dto.amount ?? orderTotal;
    if (amount > orderTotal) {
      throw new BadRequestException(
        `Refund amount ${amount.toFixed(2)} exceeds order total ${orderTotal.toFixed(2)}`,
      );
    }

    const existing = await this.prisma.refundRequest.findFirst({
      where: { orderId, status: { in: [RefundStatus.REQUESTED, RefundStatus.APPROVED] } },
    });
    if (existing) {
      throw new BadRequestException('There is already an open refund request on this order');
    }

    const created = await this.prisma.refundRequest.create({
      data: {
        orderId,
        customerId,
        amount: amount.toFixed(2),
        reason: dto.reason.trim(),
        status: RefundStatus.REQUESTED,
      },
    });
    this.logger.log(`Refund requested: order=${orderId} amount=${amount.toFixed(2)}`);
    return created;
  }

  listForAdmin(status?: RefundStatus) {
    return this.prisma.refundRequest.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
      include: {
        customer: { select: { id: true, email: true, name: true } },
        order: { select: { id: true, status: true, totalAmount: true } },
      },
    });
  }

  listForCustomer(customerId: string) {
    return this.prisma.refundRequest.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
      include: {
        order: { select: { id: true, status: true, totalAmount: true, placedAt: true } },
      },
    });
  }

  async approve(refundRequestId: string, actor: AuthenticatedUser) {
    if (actor.role !== Role.ADMIN) {
      throw new ForbiddenException('Only ADMIN can approve refunds');
    }
    const refund = await this.prisma.refundRequest.findUnique({
      where: { id: refundRequestId },
      include: { order: { include: { payments: true } } },
    });
    if (!refund) throw new NotFoundException(`Refund ${refundRequestId} not found`);
    if (refund.status !== RefundStatus.REQUESTED) {
      throw new BadRequestException(
        `Refund is in ${refund.status} status; can only approve REQUESTED`,
      );
    }
    if (refund.order.status !== OrderStatus.DELIVERED) {
      throw new BadRequestException(`Order is in ${refund.order.status}; refund needs DELIVERED`);
    }

    const paidPayment = refund.order.payments.find(
      (payment) => payment.status === PaymentStatus.PAID,
    );
    if (!paidPayment) throw new BadRequestException('No paid Payment row to refund against');

    const gatewayResult = await this.payments.refundCharge({
      gatewayPaymentId: paidPayment.gatewayPaymentId,
      amount: refund.amount.toString(),
      currency: paidPayment.currency,
      gateway: paidPayment.gateway,
    });
    if (!gatewayResult.succeeded) {
      throw new BadRequestException(
        `Gateway refund failed: ${gatewayResult.failureReason ?? 'unknown'}`,
      );
    }

    const restocked = await this.prisma.$transaction(async (tx) => {
      await tx.refundRequest.update({
        where: { id: refundRequestId },
        data: {
          status: RefundStatus.APPROVED,
          processedAt: new Date(),
          processedByAdminId: actor.id,
        },
      });
      await tx.payment.update({
        where: { id: paidPayment.id },
        data: { status: PaymentStatus.REFUNDED, processedAt: new Date() },
      });
      return this.inventory.restockOrderItems(refund.orderId, tx);
    });

    await this.orderStatus.transition(refund.orderId, OrderStatus.REFUNDED, actor, {
      refundRequestId,
      amount: refund.amount.toString(),
      gatewayRefundId: gatewayResult.refundId,
    });

    await this.audit.record({
      actorType: 'ADMIN',
      actorId: actor.id,
      action: 'refund.approve',
      targetType: 'RefundRequest',
      targetId: refundRequestId,
      metadata: {
        orderId: refund.orderId,
        amount: refund.amount.toString(),
        gatewayRefundId: gatewayResult.refundId,
        restocked: restocked.filter((item) => item.restocked).length,
        notRestockedExpired: restocked.filter((item) => !item.restocked).length,
      },
    });

    this.notifications.emitRefundApproved({
      refundRequestId,
      customerId: refund.customerId,
      orderId: refund.orderId,
      amount: refund.amount.toString(),
    });

    this.logger.log(
      `Refund approved: id=${refundRequestId} order=${refund.orderId} restocked=${restocked.filter((item) => item.restocked).length}/${restocked.length}`,
    );
    return { refundRequestId, restocked };
  }

  async reject(refundRequestId: string, actor: AuthenticatedUser, reason: string) {
    if (actor.role !== Role.ADMIN) {
      throw new ForbiddenException('Only ADMIN can reject refunds');
    }
    const refund = await this.prisma.refundRequest.findUnique({ where: { id: refundRequestId } });
    if (!refund) throw new NotFoundException(`Refund ${refundRequestId} not found`);
    if (refund.status !== RefundStatus.REQUESTED) {
      throw new BadRequestException(
        `Refund is in ${refund.status} status; can only reject REQUESTED`,
      );
    }

    const updated = await this.prisma.refundRequest.update({
      where: { id: refundRequestId },
      data: {
        status: RefundStatus.REJECTED,
        processedAt: new Date(),
        processedByAdminId: actor.id,
      },
    });
    await this.audit.record({
      actorType: 'ADMIN',
      actorId: actor.id,
      action: 'refund.reject',
      targetType: 'RefundRequest',
      targetId: refundRequestId,
      metadata: { reason: reason.trim() },
    });
    this.notifications.emitRefundRejected({
      refundRequestId,
      customerId: refund.customerId,
      orderId: refund.orderId,
      reason: reason.trim(),
    });
    return updated;
  }
}
