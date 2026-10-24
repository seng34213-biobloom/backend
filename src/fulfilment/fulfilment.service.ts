import { Injectable } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OrderStatusService } from '../orders/order-status.service';
import { NotificationsService } from '../notifications/notifications.service';
import type { AuthenticatedUser } from '../auth/types/auth.types';

@Injectable()
export class FulfilmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orderStatus: OrderStatusService,
    private readonly notifications: NotificationsService,
  ) {}

  async listOpen() {
    return this.prisma.order.findMany({
      where: { status: { in: [OrderStatus.PAID, OrderStatus.PACKING] } },
      orderBy: { placedAt: 'asc' },
      include: {
        customer: { select: { id: true, email: true, name: true } },
        shippingAddress: true,
        items: {
          include: {
            variant: { select: { sku: true, name: true, size: true } },
          },
        },
      },
    });
  }

  async listShipped() {
    return this.prisma.order.findMany({
      where: { status: OrderStatus.SHIPPED },
      orderBy: { shippedAt: 'desc' },
      include: {
        customer: { select: { id: true, email: true, name: true } },
        shippingAddress: true,
      },
    });
  }

  markPacking(orderId: string, actor: AuthenticatedUser) {
    return this.orderStatus.transition(orderId, OrderStatus.PACKING, actor);
  }

  async markShipped(orderId: string, actor: AuthenticatedUser) {
    const updated = await this.orderStatus.transition(orderId, OrderStatus.SHIPPED, actor);
    this.notifications.emitOrderShipped({ orderId, actorId: actor.id });
    return updated;
  }

  async markDelivered(orderId: string, actor: AuthenticatedUser) {
    const updated = await this.orderStatus.transition(orderId, OrderStatus.DELIVERED, actor);
    this.notifications.emitOrderDelivered({ orderId, actorId: actor.id });
    return updated;
  }
}
