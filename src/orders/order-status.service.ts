import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AuditActorType, OrderStatus, Prisma, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/types/auth.types';

export const LAWFUL_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.PENDING_PAYMENT]: [OrderStatus.PAID, OrderStatus.CANCELLED],
  [OrderStatus.PAID]: [OrderStatus.PACKING, OrderStatus.CANCELLED],
  [OrderStatus.PACKING]: [OrderStatus.SHIPPED, OrderStatus.CANCELLED],
  [OrderStatus.SHIPPED]: [OrderStatus.DELIVERED, OrderStatus.CANCELLED],
  [OrderStatus.DELIVERED]: [OrderStatus.REFUNDED],
  [OrderStatus.CANCELLED]: [],
  [OrderStatus.REFUNDED]: [],
};

@Injectable()
export class OrderStatusService {
  private readonly logger = new Logger(OrderStatusService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  assertTransition(from: OrderStatus, to: OrderStatus): void {
    if (!LAWFUL_TRANSITIONS[from]?.includes(to)) {
      throw new BadRequestException(`Illegal transition: ${from} → ${to}`);
    }
  }

  async transition(
    orderId: string,
    to: OrderStatus,
    actor: AuthenticatedUser,
    metadata?: Record<string, unknown>,
  ) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, status: true, customerId: true },
    });
    if (!order) throw new NotFoundException(`Order ${orderId} not found`);

    if (actor.role === Role.CUSTOMER) {
      if (order.customerId !== actor.id) {
        throw new ForbiddenException('Not your order');
      }
      if (!(order.status === OrderStatus.PENDING_PAYMENT && to === OrderStatus.CANCELLED)) {
        throw new ForbiddenException('Customers can only cancel PENDING_PAYMENT orders');
      }
    }

    if (actor.role === Role.DELIVERY) {
      if (!(order.status === OrderStatus.SHIPPED && to === OrderStatus.DELIVERED)) {
        throw new ForbiddenException('Delivery riders can only transition SHIPPED → DELIVERED');
      }
    }

    this.assertTransition(order.status, to);

    const data: Prisma.OrderUpdateInput = { status: to };
    if (to === OrderStatus.SHIPPED) data.shippedAt = new Date();
    if (to === OrderStatus.DELIVERED) data.deliveredAt = new Date();
    if (to === OrderStatus.CANCELLED) data.cancelledAt = new Date();

    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data,
      select: {
        id: true,
        status: true,
        shippedAt: true,
        deliveredAt: true,
        cancelledAt: true,
      },
    });

    const isAdmin = actor.role === Role.ADMIN || actor.role === Role.FULFILMENT_STAFF;
    const actorType: AuditActorType = isAdmin
      ? AuditActorType.ADMIN
      : actor.role === Role.DELIVERY
        ? AuditActorType.SYSTEM
        : AuditActorType.CUSTOMER;
    await this.audit.record({
      actorType,
      actorId: isAdmin ? actor.id : null,
      action: `order.${to.toLowerCase()}`,
      targetType: 'Order',
      targetId: orderId,
      metadata: { from: order.status, to, actorId: actor.id, actorRole: actor.role, ...metadata },
    });

    this.logger.log(`Order ${orderId}: ${order.status} → ${to} (actor=${actor.actorType})`);
    return updated;
  }
}
