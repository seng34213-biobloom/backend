import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { OrderStatus, PaymentStatus, RefundStatus, Role, Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/types/auth.types';
import { InventoryService } from '../inventory/inventory.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OrderStatusService } from '../orders/order-status.service';
import { PaymentsService } from '../payments/payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { RefundsService } from './refunds.service';

describe('RefundsService', () => {
  let service: RefundsService;
  let prisma: jest.Mocked<PrismaService>;
  let audit: jest.Mocked<Pick<AuditService, 'record'>>;
  let inventory: jest.Mocked<Pick<InventoryService, 'restockOrderItems'>>;
  let payments: jest.Mocked<Pick<PaymentsService, 'refundCharge'>>;
  let orderStatus: jest.Mocked<Pick<OrderStatusService, 'transition'>>;
  let notifications: jest.Mocked<
    Pick<NotificationsService, 'emitRefundApproved' | 'emitRefundRejected'>
  >;

  const admin: AuthenticatedUser = {
    id: 'admin-1',
    email: 'admin@example.com',
    role: Role.ADMIN,
    actorType: 'admin',
    jti: 'admin-jti',
    expiresAt: 0,
  };

  const deliveredOrder = {
    id: 'order-1',
    status: OrderStatus.DELIVERED,
    totalAmount: new Prisma.Decimal('100.00'),
    customerId: 'customer-1',
  };

  const paidPayment = {
    id: 'payment-1',
    status: PaymentStatus.PAID,
    gatewayPaymentId: 'gateway-payment-1',
    currency: 'LKR',
    gateway: 'STRIPE',
  };

  const refund = {
    id: 'refund-1',
    orderId: 'order-1',
    customerId: 'customer-1',
    amount: new Prisma.Decimal('100.00'),
    reason: 'Damaged item',
    status: RefundStatus.REQUESTED,
    order: { ...deliveredOrder, payments: [paidPayment] },
  };

  beforeEach(() => {
    const tx = {
      refundRequest: {
        update: jest.fn().mockResolvedValue({ ...refund, status: RefundStatus.APPROVED }),
      },
      payment: {
        update: jest.fn().mockResolvedValue({ ...paidPayment, status: PaymentStatus.REFUNDED }),
      },
    };
    const mock = {
      order: { findUnique: jest.fn().mockResolvedValue(deliveredOrder) },
      refundRequest: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(refund),
        create: jest.fn().mockResolvedValue(refund),
        update: jest.fn().mockResolvedValue({ ...refund, status: RefundStatus.REJECTED }),
      },
      $transaction: jest.fn((work: (client: unknown) => unknown) => work(tx)),
    };
    prisma = mock as unknown as jest.Mocked<PrismaService>;
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    inventory = {
      restockOrderItems: jest.fn().mockResolvedValue([
        { batchId: 'batch-good', quantity: 1, restocked: true },
        { batchId: 'batch-expired', quantity: 1, restocked: false },
      ]),
    };
    payments = {
      refundCharge: jest.fn().mockResolvedValue({ succeeded: true, refundId: 'gateway-refund-1' }),
    };
    orderStatus = { transition: jest.fn().mockResolvedValue({ id: 'order-1' }) };
    notifications = {
      emitRefundApproved: jest.fn(),
      emitRefundRejected: jest.fn(),
    };
    service = new RefundsService(
      prisma,
      audit as unknown as AuditService,
      inventory as unknown as InventoryService,
      payments as unknown as PaymentsService,
      orderStatus as unknown as OrderStatusService,
      notifications as unknown as NotificationsService,
    );
  });

  describe('requestRefund', () => {
    const request = { reason: '  Damaged item  ' };

    it('creates a full-value refund request for an owned delivered order', async () => {
      await expect(service.requestRefund('customer-1', 'order-1', request)).resolves.toEqual(
        refund,
      );

      expect(prisma.refundRequest.create).toHaveBeenCalledWith({
        data: {
          orderId: 'order-1',
          customerId: 'customer-1',
          amount: '100.00',
          reason: 'Damaged item',
          status: RefundStatus.REQUESTED,
        },
      });
    });

    it('uses an explicitly provided amount', async () => {
      await service.requestRefund('customer-1', 'order-1', { ...request, amount: 50 });

      expect(prisma.refundRequest.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ amount: '50.00' }),
      });
    });

    it('rejects an unknown order', async () => {
      (prisma.order.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.requestRefund('customer-1', 'missing', request)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('rejects a non-owner', async () => {
      await expect(service.requestRefund('customer-2', 'order-1', request)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.refundRequest.create).not.toHaveBeenCalled();
    });

    it('rejects an order that has not been delivered', async () => {
      (prisma.order.findUnique as jest.Mock).mockResolvedValue({
        ...deliveredOrder,
        status: OrderStatus.SHIPPED,
      });

      await expect(service.requestRefund('customer-1', 'order-1', request)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects an amount greater than the order total', async () => {
      await expect(
        service.requestRefund('customer-1', 'order-1', { ...request, amount: 100.01 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.refundRequest.create).not.toHaveBeenCalled();
    });

    it('rejects a duplicate open refund request', async () => {
      (prisma.refundRequest.findFirst as jest.Mock).mockResolvedValue(refund);

      await expect(service.requestRefund('customer-1', 'order-1', request)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.refundRequest.create).not.toHaveBeenCalled();
    });
  });

  describe('lists', () => {
    it('filters the admin list by status when provided', async () => {
      await service.listForAdmin(RefundStatus.REQUESTED);

      expect(prisma.refundRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: RefundStatus.REQUESTED },
          orderBy: { createdAt: 'desc' },
        }),
      );
    });

    it('lists all refund requests for admins when no status is provided', async () => {
      await service.listForAdmin();

      expect(prisma.refundRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: undefined }),
      );
    });

    it('scopes the customer list to that customer', async () => {
      await service.listForCustomer('customer-1');

      expect(prisma.refundRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { customerId: 'customer-1' } }),
      );
    });
  });

  describe('approve', () => {
    it('refunds the paid charge, restocks through inventory, audits and notifies', async () => {
      const result = await service.approve('refund-1', admin);

      expect(payments.refundCharge).toHaveBeenCalledWith({
        gatewayPaymentId: 'gateway-payment-1',
        amount: '100',
        currency: 'LKR',
        gateway: 'STRIPE',
      });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(inventory.restockOrderItems).toHaveBeenCalledWith('order-1', expect.anything());
      expect(orderStatus.transition).toHaveBeenCalledWith(
        'order-1',
        OrderStatus.REFUNDED,
        admin,
        expect.objectContaining({
          refundRequestId: 'refund-1',
          gatewayRefundId: 'gateway-refund-1',
        }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'refund.approve',
          metadata: expect.objectContaining({ restocked: 1, notRestockedExpired: 1 }),
        }),
      );
      expect(notifications.emitRefundApproved).toHaveBeenCalledWith({
        refundRequestId: 'refund-1',
        customerId: 'customer-1',
        orderId: 'order-1',
        amount: '100',
      });
      expect(result).toEqual({
        refundRequestId: 'refund-1',
        restocked: [
          { batchId: 'batch-good', quantity: 1, restocked: true },
          { batchId: 'batch-expired', quantity: 1, restocked: false },
        ],
      });
    });

    it('rejects approval by a non-admin', async () => {
      await expect(
        service.approve('refund-1', { ...admin, role: Role.FULFILMENT_STAFF }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.refundRequest.findUnique).not.toHaveBeenCalled();
    });

    it('rejects an unknown request', async () => {
      (prisma.refundRequest.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.approve('missing', admin)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects a request not in REQUESTED status', async () => {
      (prisma.refundRequest.findUnique as jest.Mock).mockResolvedValue({
        ...refund,
        status: RefundStatus.REJECTED,
      });

      await expect(service.approve('refund-1', admin)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects approval when the order is no longer delivered', async () => {
      (prisma.refundRequest.findUnique as jest.Mock).mockResolvedValue({
        ...refund,
        order: { ...refund.order, status: OrderStatus.SHIPPED },
      });

      await expect(service.approve('refund-1', admin)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects approval when no paid payment exists', async () => {
      (prisma.refundRequest.findUnique as jest.Mock).mockResolvedValue({
        ...refund,
        order: { ...refund.order, payments: [{ ...paidPayment, status: PaymentStatus.FAILED }] },
      });

      await expect(service.approve('refund-1', admin)).rejects.toBeInstanceOf(BadRequestException);
      expect(payments.refundCharge).not.toHaveBeenCalled();
    });

    it('does not update or restock when the gateway refund fails', async () => {
      payments.refundCharge.mockResolvedValue({
        succeeded: false,
        refundId: '',
        failureReason: 'card declined',
      });

      await expect(service.approve('refund-1', admin)).rejects.toThrow(/card declined/);

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(inventory.restockOrderItems).not.toHaveBeenCalled();
    });
  });

  describe('reject', () => {
    it('marks the request rejected, audits the reason and emits a rejection event', async () => {
      await service.reject('refund-1', admin, '  Outside refund window  ');

      expect(prisma.refundRequest.update).toHaveBeenCalledWith({
        where: { id: 'refund-1' },
        data: expect.objectContaining({
          status: RefundStatus.REJECTED,
          processedByAdminId: admin.id,
        }),
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'refund.reject',
          metadata: { reason: 'Outside refund window' },
        }),
      );
      expect(notifications.emitRefundRejected).toHaveBeenCalledWith({
        refundRequestId: 'refund-1',
        customerId: 'customer-1',
        orderId: 'order-1',
        reason: 'Outside refund window',
      });
    });

    it('rejects rejection by a non-admin', async () => {
      await expect(
        service.reject('refund-1', { ...admin, role: Role.CUSTOMER }, 'reason'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects an unknown request', async () => {
      (prisma.refundRequest.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.reject('missing', admin, 'reason')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('rejects a request not in REQUESTED status', async () => {
      (prisma.refundRequest.findUnique as jest.Mock).mockResolvedValue({
        ...refund,
        status: RefundStatus.APPROVED,
      });

      await expect(service.reject('refund-1', admin, 'reason')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.refundRequest.update).not.toHaveBeenCalled();
    });
  });
});
