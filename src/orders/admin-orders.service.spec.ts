import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { OrderStatus, PaymentStatus, Prisma, Role } from '@prisma/client';
import type { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import type { InventoryService } from '../inventory/inventory.service';
import type { PaymentsService } from '../payments/payments.service';
import type { PrismaService } from '../prisma/prisma.service';
import { AdminOrdersService } from './admin-orders.service';
import { OrderStatusService } from './order-status.service';

const admin = { id: 'admin-1', role: Role.ADMIN } as AuthenticatedUser;
const customer = { id: 'customer-1', role: Role.CUSTOMER } as AuthenticatedUser;
const decimal = (value: string) => new Prisma.Decimal(value);

const detailRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'order-1',
  orderNumber: 7,
  status: OrderStatus.PAID,
  paymentStatus: PaymentStatus.PAID,
  totalAmount: decimal('1000'),
  totalWeight: decimal('500'),
  shippingFee: decimal('200'),
  currency: 'LKR',
  placedAt: new Date(),
  shippedAt: null,
  deliveredAt: null,
  cancelledAt: null,
  cancellationReason: null,
  customer: { id: 'customer-1', name: 'Nimal', email: 'n@example.com', phone: null },
  shippingAddress: { line1: '1 Road' },
  items: [
    {
      id: 'item-1',
      batchId: 'batch-1',
      quantity: 2,
      unitPriceSnapshot: decimal('400'),
      lineTotal: decimal('800'),
      variant: { sku: 'SKU', name: 'Jam', size: '250g', product: { name: 'Jam' } },
    },
  ],
  payments: [
    {
      id: 'pay-1',
      gateway: 'STRIPE',
      status: PaymentStatus.REFUNDED,
      amount: decimal('1000'),
    },
  ],
  refundRequests: [
    {
      id: 'refund-1',
      amount: decimal('100'),
      reason: 'Broken jar',
      status: 'REQUESTED',
      createdAt: new Date(),
    },
  ],
  deliveryAssignment: {
    status: 'ASSIGNED',
    failureReason: null,
    assignedAt: new Date(),
    deliveredAt: null,
    deliveryUser: { name: 'Rider' },
  },
  ...overrides,
});

describe('AdminOrdersService', () => {
  let prisma: jest.Mocked<PrismaService>;
  let inventory: { restockOrderItems: jest.Mock };
  let payments: { refundCharge: jest.Mock };
  let audit: { record: jest.Mock };
  let service: AdminOrdersService;

  beforeEach(() => {
    prisma = {
      order: {
        count: jest.fn().mockResolvedValue(1),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      payment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      $transaction: jest.fn(async (work: unknown) =>
        typeof work === 'function'
          ? (work as (tx: unknown) => unknown)(prisma)
          : Promise.all(work as Promise<unknown>[]),
      ),
    } as unknown as jest.Mocked<PrismaService>;
    inventory = { restockOrderItems: jest.fn().mockResolvedValue([]) };
    payments = { refundCharge: jest.fn().mockResolvedValue({ succeeded: true }) };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new AdminOrdersService(
      prisma,
      inventory as unknown as InventoryService,
      payments as unknown as PaymentsService,
      new OrderStatusService(prisma, audit as unknown as AuditService),
      audit as unknown as AuditService,
    );
  });

  describe('list', () => {
    it('searches by order number and customer, ignoring the BB- prefix', async () => {
      (prisma.order.findMany as jest.Mock).mockResolvedValue([
        {
          ...detailRow(),
          _count: { items: 3 },
          deliveryAssignment: null,
        },
      ]);

      const out = await service.list({ search: 'BB-000007', status: OrderStatus.PAID });

      const { where } = (prisma.order.findMany as jest.Mock).mock.calls[0][0];
      expect(where.status).toBe(OrderStatus.PAID);
      expect(where.OR[0]).toEqual({ orderNumber: 7 });
      expect(out).toMatchObject({ total: 1, page: 1, pageSize: 25 });
      expect(out.items[0]).toMatchObject({
        totalAmount: '1000.00',
        itemCount: 3,
        deliveryStatus: null,
      });
    });

    it('matches only customers when the search is not a number', async () => {
      await service.list({ search: 'nimal', page: 2, pageSize: 10 });

      const args = (prisma.order.findMany as jest.Mock).mock.calls[0][0];
      expect(args.where.OR).toHaveLength(2);
      expect(args.skip).toBe(10);
    });
  });

  describe('get', () => {
    it('answers 404 for an unknown order', async () => {
      (prisma.order.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(service.get('missing')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('derives the subtotal, refunded amounts and delivery summary', async () => {
      (prisma.order.findUnique as jest.Mock).mockResolvedValue(detailRow());

      const out = await service.get('order-1');

      expect(out).toMatchObject({ subtotal: '800.00', totalWeightG: 500, promoCode: null });
      expect(out.payments[0].refundedAmount).toBe('1000.00');
      expect(out.delivery).toMatchObject({ riderName: 'Rider', status: 'ASSIGNED' });
    });

    it('returns no delivery before an assignment exists', async () => {
      (prisma.order.findUnique as jest.Mock).mockResolvedValue(
        detailRow({ deliveryAssignment: null }),
      );
      expect((await service.get('order-1')).delivery).toBeNull();
    });
  });

  describe('cancelByAdmin', () => {
    const paidOrder = {
      id: 'order-1',
      status: OrderStatus.PAID,
      payments: [
        {
          id: 'pay-1',
          status: PaymentStatus.PAID,
          gatewayPaymentId: 'pi_1',
          amount: decimal('1000'),
          currency: 'LKR',
          gateway: 'STRIPE',
        },
      ],
    };

    it('refunds the charge, restocks and records who cancelled', async () => {
      (prisma.order.findUnique as jest.Mock)
        .mockResolvedValueOnce(paidOrder)
        .mockResolvedValueOnce(detailRow({ status: OrderStatus.CANCELLED }));

      await service.cancelByAdmin('order-1', 'Out of stock', admin);

      expect(payments.refundCharge).toHaveBeenCalledWith(
        expect.objectContaining({ gatewayPaymentId: 'pi_1' }),
      );
      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'order-1', status: OrderStatus.PAID },
        data: expect.objectContaining({
          status: OrderStatus.CANCELLED,
          cancellationReason: 'Out of stock',
          paymentStatus: PaymentStatus.REFUNDED,
        }),
      });
      expect(inventory.restockOrderItems).toHaveBeenCalledWith('order-1', prisma);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'order.cancelled', actorId: admin.id }),
      );
    });

    it('leaves the order alone when the gateway declines the refund', async () => {
      (prisma.order.findUnique as jest.Mock).mockResolvedValue(paidOrder);
      payments.refundCharge.mockResolvedValue({ succeeded: false, failureReason: 'declined' });

      await expect(service.cancelByAdmin('order-1', 'Reason', admin)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
      expect(inventory.restockOrderItems).not.toHaveBeenCalled();
    });

    it('fails unpaid payments instead of refunding them', async () => {
      (prisma.order.findUnique as jest.Mock)
        .mockResolvedValueOnce({
          id: 'order-1',
          status: OrderStatus.PENDING_PAYMENT,
          payments: [{ status: PaymentStatus.PENDING }],
        })
        .mockResolvedValueOnce(detailRow());

      await service.cancelByAdmin('order-1', 'Reason', admin);

      expect(payments.refundCharge).not.toHaveBeenCalled();
      expect(prisma.payment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
      );
    });

    it('refuses an order that can no longer be cancelled', async () => {
      (prisma.order.findUnique as jest.Mock).mockResolvedValue({
        id: 'order-1',
        status: OrderStatus.DELIVERED,
        payments: [],
      });
      await expect(service.cancelByAdmin('order-1', 'Reason', admin)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('answers 404 for an unknown order', async () => {
      (prisma.order.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(service.cancelByAdmin('missing', 'Reason', admin)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('reports a conflict when the order changed during the cancellation', async () => {
      (prisma.order.findUnique as jest.Mock).mockResolvedValue({ ...paidOrder, payments: [] });
      (prisma.order.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

      await expect(service.cancelByAdmin('order-1', 'Reason', admin)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(inventory.restockOrderItems).not.toHaveBeenCalled();
    });
  });

  describe('cancelUnpaid', () => {
    const unpaid = {
      id: 'order-1',
      status: OrderStatus.PENDING_PAYMENT,
      customerId: customer.id,
    };

    it('cancels and restocks the customer own unpaid order', async () => {
      (prisma.order.findUnique as jest.Mock).mockResolvedValue(unpaid);

      await service.cancelUnpaid('order-1', customer);

      expect(inventory.restockOrderItems).toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ actorType: 'CUSTOMER', actorId: null }),
      );
    });

    it('refuses someone else order', async () => {
      (prisma.order.findUnique as jest.Mock).mockResolvedValue({ ...unpaid, customerId: 'other' });
      await expect(service.cancelUnpaid('order-1', customer)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('refuses a paid order', async () => {
      (prisma.order.findUnique as jest.Mock).mockResolvedValue({
        ...unpaid,
        status: OrderStatus.PAID,
      });
      await expect(service.cancelUnpaid('order-1', customer)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('answers 404 for an unknown order', async () => {
      (prisma.order.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(service.cancelUnpaid('order-1', customer)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
