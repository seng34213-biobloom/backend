import { OrderStatus } from '@prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import { OrderStatusService } from '../orders/order-status.service';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { FulfilmentService } from './fulfilment.service';

describe('FulfilmentService', () => {
  let service: FulfilmentService;
  let prisma: jest.Mocked<PrismaService>;
  let orderStatus: jest.Mocked<Pick<OrderStatusService, 'transition'>>;
  let notifications: jest.Mocked<
    Pick<NotificationsService, 'emitOrderShipped' | 'emitOrderDelivered'>
  >;

  const staff: AuthenticatedUser = {
    id: 'staff-1',
    email: 'staff@example.com',
    role: 'FULFILMENT_STAFF',
    actorType: 'admin',
    jti: 'jti',
    expiresAt: 0,
  };

  beforeEach(() => {
    prisma = {
      order: { findMany: jest.fn() },
    } as unknown as jest.Mocked<PrismaService>;
    orderStatus = { transition: jest.fn().mockResolvedValue({ id: 'order-1' }) };
    notifications = {
      emitOrderShipped: jest.fn(),
      emitOrderDelivered: jest.fn(),
    };
    service = new FulfilmentService(
      prisma,
      orderStatus as unknown as OrderStatusService,
      notifications as unknown as NotificationsService,
    );
  });

  it('lists only paid and packing orders in oldest-first order', async () => {
    (prisma.order.findMany as jest.Mock).mockResolvedValue([]);

    await expect(service.listOpen()).resolves.toEqual([]);

    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: { in: [OrderStatus.PAID, OrderStatus.PACKING] } },
        orderBy: { placedAt: 'asc' },
      }),
    );
  });

  it('lists shipped orders newest-first', async () => {
    (prisma.order.findMany as jest.Mock).mockResolvedValue([]);

    await expect(service.listShipped()).resolves.toEqual([]);

    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: OrderStatus.SHIPPED },
        orderBy: { shippedAt: 'desc' },
      }),
    );
  });

  it('transitions an order to packing without sending a customer email', async () => {
    await service.markPacking('order-1', staff);

    expect(orderStatus.transition).toHaveBeenCalledWith('order-1', OrderStatus.PACKING, staff);
    expect(notifications.emitOrderShipped).not.toHaveBeenCalled();
    expect(notifications.emitOrderDelivered).not.toHaveBeenCalled();
  });

  it('audits a ship transition and emits the customer notification', async () => {
    await service.markShipped('order-1', staff);

    expect(orderStatus.transition).toHaveBeenCalledWith('order-1', OrderStatus.SHIPPED, staff);
    expect(notifications.emitOrderShipped).toHaveBeenCalledWith({
      orderId: 'order-1',
      actorId: staff.id,
    });
  });

  it('emits the delivery notification only after the transition succeeds', async () => {
    await service.markDelivered('order-1', staff);

    expect(orderStatus.transition).toHaveBeenCalledWith('order-1', OrderStatus.DELIVERED, staff);
    expect(notifications.emitOrderDelivered).toHaveBeenCalledWith({
      orderId: 'order-1',
      actorId: staff.id,
    });
  });

  it('does not emit a shipment email when the transition fails', async () => {
    orderStatus.transition.mockRejectedValueOnce(new Error('Illegal transition'));

    await expect(service.markShipped('order-1', staff)).rejects.toThrow('Illegal transition');

    expect(notifications.emitOrderShipped).not.toHaveBeenCalled();
  });
});
