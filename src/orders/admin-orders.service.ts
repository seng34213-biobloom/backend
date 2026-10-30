import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AuditActorType, OrderStatus, PaymentStatus, Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { InventoryService } from '../inventory/inventory.service';
import { PaymentsService } from '../payments/payments.service';
import { PrismaService } from '../prisma/prisma.service';
import type { AdminOrdersQueryDto } from './dto/admin-orders-query.dto';
import { OrderStatusService } from './order-status.service';

const money = (value: Prisma.Decimal) => value.toFixed(2);

const adminDetailInclude = {
  customer: { select: { id: true, name: true, email: true, phone: true } },
  shippingAddress: true,
  items: {
    include: {
      variant: {
        select: { sku: true, name: true, size: true, product: { select: { name: true } } },
      },
    },
  },
  payments: { orderBy: { createdAt: 'asc' as const } },
  refundRequests: { orderBy: { createdAt: 'desc' as const } },
  deliveryAssignment: { include: { deliveryUser: { select: { name: true } } } },
} satisfies Prisma.OrderInclude;

/** Staff view of every order, plus cancellation for staff and customers (SDS §6.5). */
@Injectable()
export class AdminOrdersService {
  private readonly logger = new Logger(AdminOrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly payments: PaymentsService,
    private readonly orderStatus: OrderStatusService,
    private readonly audit: AuditService,
  ) {}

  async list(query: AdminOrdersQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const search = query.search?.trim();
    const orderNumber = search ? Number(search.replace(/^BB-?/i, '')) : NaN;
    const where: Prisma.OrderWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(search
        ? {
            OR: [
              ...(Number.isSafeInteger(orderNumber) && orderNumber > 0 ? [{ orderNumber }] : []),
              { customer: { email: { contains: search, mode: 'insensitive' as const } } },
              { customer: { name: { contains: search, mode: 'insensitive' as const } } },
            ],
          }
        : {}),
    };

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        orderBy: { placedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          customer: { select: { id: true, name: true, email: true } },
          _count: { select: { items: true } },
          deliveryAssignment: { select: { status: true } },
        },
      }),
    ]);

    return {
      items: rows.map((order) => ({
        id: order.id,
        orderNumber: order.orderNumber,
        placedAt: order.placedAt,
        status: order.status,
        paymentStatus: order.paymentStatus,
        totalAmount: money(order.totalAmount),
        currency: order.currency,
        itemCount: order._count.items,
        customer: order.customer,
        deliveryStatus: order.deliveryAssignment?.status ?? null,
      })),
      total,
      page,
      pageSize,
    };
  }

  async get(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: adminDetailInclude,
    });
    if (!order) throw new NotFoundException(`Order ${orderId} not found`);

    const subtotal = order.items.reduce(
      (sum, item) => sum.plus(item.lineTotal),
      new Prisma.Decimal(0),
    );
    const delivery = order.deliveryAssignment;
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      paymentStatus: order.paymentStatus,
      subtotal: money(subtotal),
      discountAmount: '0.00',
      promoCode: null,
      shippingFee: money(order.shippingFee),
      totalAmount: money(order.totalAmount),
      totalWeightG: Number(order.totalWeight),
      currency: order.currency,
      placedAt: order.placedAt,
      shippedAt: order.shippedAt,
      deliveredAt: order.deliveredAt,
      cancelledAt: order.cancelledAt,
      cancellationReason: order.cancellationReason,
      customer: order.customer,
      shippingAddress: order.shippingAddress,
      items: order.items.map((item) => ({
        id: item.id,
        productName: item.variant.product.name,
        variantName: item.variant.name,
        size: item.variant.size,
        sku: item.variant.sku,
        bundleName: null,
        batchId: item.batchId,
        quantity: item.quantity,
        unitPriceSnapshot: money(item.unitPriceSnapshot),
        lineTotal: money(item.lineTotal),
      })),
      payments: order.payments.map((payment) => ({
        id: payment.id,
        gateway: payment.gateway,
        status: payment.status,
        amount: money(payment.amount),
        refundedAmount: payment.status === PaymentStatus.REFUNDED ? money(payment.amount) : '0.00',
      })),
      refundRequests: order.refundRequests.map((refund) => ({
        id: refund.id,
        amount: money(refund.amount),
        reason: refund.reason,
        status: refund.status,
        createdAt: refund.createdAt,
      })),
      delivery: delivery
        ? {
            status: delivery.status,
            riderName: delivery.deliveryUser.name,
            attempts: 1,
            failureReason: delivery.failureReason,
            assignedAt: delivery.assignedAt,
            deliveredAt: delivery.deliveredAt,
          }
        : null,
    };
  }

  /** Cancels any open order: refunds what was captured and returns the stock. */
  async cancelByAdmin(orderId: string, reason: string, actor: AuthenticatedUser) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { payments: true },
    });
    if (!order) throw new NotFoundException(`Order ${orderId} not found`);
    this.orderStatus.assertTransition(order.status, OrderStatus.CANCELLED);

    let refunded = false;
    for (const payment of order.payments) {
      if (payment.status !== PaymentStatus.PAID) continue;
      const result = await this.payments.refundCharge({
        gatewayPaymentId: payment.gatewayPaymentId,
        amount: payment.amount.toString(),
        currency: payment.currency,
        gateway: payment.gateway,
      });
      if (!result.succeeded) {
        throw new BadRequestException(
          `Gateway refund failed (${result.failureReason ?? 'unknown'}); the order was not cancelled`,
        );
      }
      refunded = true;
    }

    const restocked = await this.markCancelled(order.id, order.status, reason, refunded);
    await this.audit.record({
      actorType: AuditActorType.ADMIN,
      actorId: actor.id,
      action: 'order.cancelled',
      targetType: 'Order',
      targetId: orderId,
      metadata: { from: order.status, to: OrderStatus.CANCELLED, reason, refunded, restocked },
    });
    this.logger.log(`Order ${orderId} cancelled by ${actor.role} ${actor.id}`);
    return this.get(orderId);
  }

  /** Customers may cancel their own order until it has been paid. */
  async cancelUnpaid(orderId: string, actor: AuthenticatedUser): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, status: true, customerId: true },
    });
    if (!order) throw new NotFoundException(`Order ${orderId} not found`);
    if (order.customerId !== actor.id) throw new ForbiddenException('Not your order');
    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      throw new BadRequestException('Only unpaid orders can be cancelled');
    }

    const restocked = await this.markCancelled(order.id, order.status, null, false);
    await this.audit.record({
      actorType: AuditActorType.CUSTOMER,
      actorId: null,
      action: 'order.cancelled',
      targetType: 'Order',
      targetId: orderId,
      metadata: {
        from: order.status,
        to: OrderStatus.CANCELLED,
        customerId: actor.id,
        restocked,
      },
    });
  }

  /** The conditional update loses cleanly if the order changed in the meantime. */
  private async markCancelled(
    orderId: string,
    from: OrderStatus,
    reason: string | null,
    refunded: boolean,
  ) {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const unpaid = from === OrderStatus.PENDING_PAYMENT;
      const { count } = await tx.order.updateMany({
        where: { id: orderId, status: from },
        data: {
          status: OrderStatus.CANCELLED,
          cancelledAt: now,
          cancellationReason: reason,
          ...(refunded ? { paymentStatus: PaymentStatus.REFUNDED } : {}),
          ...(unpaid ? { paymentStatus: PaymentStatus.FAILED } : {}),
        },
      });
      if (count === 0) throw new ConflictException('Order status changed; refresh and try again');

      if (unpaid) {
        await tx.payment.updateMany({
          where: { orderId, status: PaymentStatus.PENDING },
          data: { status: PaymentStatus.FAILED, processedAt: now },
        });
      }
      if (refunded) {
        await tx.payment.updateMany({
          where: { orderId, status: PaymentStatus.PAID },
          data: { status: PaymentStatus.REFUNDED, processedAt: now },
        });
      }
      return this.inventory.restockOrderItems(orderId, tx);
    });
  }
}
