import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { OrderStatus, Role } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { LAWFUL_TRANSITIONS, OrderStatusService } from './order-status.service';

function actor(role: Role, id = 'actor-1'): AuthenticatedUser {
  return {
    id,
    email: '',
    role,
    actorType: role === Role.CUSTOMER ? 'customer' : role === Role.DELIVERY ? 'delivery' : 'admin',
    jti: 'j',
    expiresAt: 0,
  };
}

describe('OrderStatusService', () => {
  let service: OrderStatusService;
  let prisma: jest.Mocked<PrismaService>;
  let audit: jest.Mocked<Pick<AuditService, 'record'>>;

  beforeEach(() => {
    prisma = {
      order: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    } as unknown as jest.Mocked<PrismaService>;
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new OrderStatusService(prisma, audit as unknown as AuditService);
  });

  describe('assertTransition', () => {
    it.each([
      [OrderStatus.PENDING_PAYMENT, OrderStatus.PAID, true],
      [OrderStatus.PENDING_PAYMENT, OrderStatus.CANCELLED, true],
      [OrderStatus.PENDING_PAYMENT, OrderStatus.SHIPPED, false],
      [OrderStatus.PAID, OrderStatus.PACKING, true],
      [OrderStatus.PAID, OrderStatus.DELIVERED, false],
      [OrderStatus.PACKING, OrderStatus.SHIPPED, true],
      [OrderStatus.SHIPPED, OrderStatus.DELIVERED, true],
      [OrderStatus.DELIVERED, OrderStatus.REFUNDED, true],
      [OrderStatus.CANCELLED, OrderStatus.PAID, false],
      [OrderStatus.REFUNDED, OrderStatus.PAID, false],
    ])('%s -> %s allowed=%p', (from, to, allowed) => {
      if (allowed) {
        expect(() => service.assertTransition(from, to)).not.toThrow();
      } else {
        expect(() => service.assertTransition(from, to)).toThrow(BadRequestException);
      }
    });

    it('keeps terminal statuses closed', () => {
      expect(LAWFUL_TRANSITIONS[OrderStatus.CANCELLED]).toEqual([]);
      expect(LAWFUL_TRANSITIONS[OrderStatus.REFUNDED]).toEqual([]);
    });
  });

  describe('transition', () => {
    function mockOrder(status: OrderStatus, customerId = 'customer-1') {
      (prisma.order.findUnique as jest.Mock).mockResolvedValue({
        id: 'order-1',
        status,
        customerId,
      });
      (prisma.order.update as jest.Mock).mockResolvedValue({
        id: 'order-1',
        status,
        shippedAt: null,
        deliveredAt: null,
        cancelledAt: null,
      });
    }

    it('stamps shippedAt and audits the change', async () => {
      mockOrder(OrderStatus.PACKING);
      await service.transition('order-1', OrderStatus.SHIPPED, actor(Role.FULFILMENT_STAFF));

      expect((prisma.order.update as jest.Mock).mock.calls[0][0].data).toMatchObject({
        status: OrderStatus.SHIPPED,
        shippedAt: expect.any(Date),
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'order.shipped',
          targetType: 'Order',
          targetId: 'order-1',
          metadata: expect.objectContaining({
            from: OrderStatus.PACKING,
            to: OrderStatus.SHIPPED,
          }),
        }),
      );
    });

    it('sets delivery and cancellation timestamps', async () => {
      mockOrder(OrderStatus.SHIPPED);
      await service.transition('order-1', OrderStatus.DELIVERED, actor(Role.ADMIN));
      expect((prisma.order.update as jest.Mock).mock.calls[0][0].data.deliveredAt).toBeInstanceOf(
        Date,
      );

      mockOrder(OrderStatus.PAID);
      await service.transition('order-1', OrderStatus.CANCELLED, actor(Role.ADMIN));
      expect((prisma.order.update as jest.Mock).mock.calls[1][0].data.cancelledAt).toBeInstanceOf(
        Date,
      );
    });

    it('rejects an illegal transition', async () => {
      mockOrder(OrderStatus.PENDING_PAYMENT);
      await expect(
        service.transition('order-1', OrderStatus.SHIPPED, actor(Role.FULFILMENT_STAFF)),
      ).rejects.toThrow(BadRequestException);
    });

    it('returns not found for unknown orders', async () => {
      (prisma.order.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(
        service.transition('missing', OrderStatus.PACKING, actor(Role.ADMIN)),
      ).rejects.toThrow(NotFoundException);
    });

    it('allows customers to cancel only their own pending orders', async () => {
      mockOrder(OrderStatus.PENDING_PAYMENT);
      await service.transition(
        'order-1',
        OrderStatus.CANCELLED,
        actor(Role.CUSTOMER, 'customer-1'),
      );

      mockOrder(OrderStatus.PENDING_PAYMENT);
      await expect(
        service.transition('order-1', OrderStatus.CANCELLED, actor(Role.CUSTOMER, 'other')),
      ).rejects.toThrow(ForbiddenException);

      mockOrder(OrderStatus.PAID);
      await expect(
        service.transition('order-1', OrderStatus.PACKING, actor(Role.CUSTOMER)),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
