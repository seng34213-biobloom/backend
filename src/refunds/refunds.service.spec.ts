import { BadRequestException } from '@nestjs/common';
import { Prisma, RefundStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { InventoryService } from '../inventory/inventory.service';
import { OrderStatusService } from '../orders/order-status.service';
import { PaymentsService } from '../payments/payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RefundsService } from './refunds.service';

describe('RefundsService', () => {
  let service: RefundsService;
  let prisma: jest.Mocked<PrismaService>;

  beforeEach(() => {
    prisma = {
      order: { findUnique: jest.fn() },
      refundRequest: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'refund-1' }),
      },
    } as unknown as jest.Mocked<PrismaService>;
    service = new RefundsService(
      prisma,
      {} as AuditService,
      {} as InventoryService,
      {} as PaymentsService,
      {} as OrderStatusService,
      {} as NotificationsService,
    );
    (prisma.order.findUnique as jest.Mock).mockResolvedValue({
      id: 'order-1',
      status: 'DELIVERED',
      totalAmount: new Prisma.Decimal('18.50'),
      customerId: 'customer-1',
    });
  });

  it('rejects partial refund requests because approval refunds the whole order', async () => {
    await expect(
      service.requestRefund('customer-1', 'order-1', {
        amount: 10,
        reason: 'One item arrived broken',
      }),
    ).rejects.toThrow(BadRequestException);

    expect(prisma.refundRequest.create).not.toHaveBeenCalled();
  });

  it('records a request for the full order total', async () => {
    await service.requestRefund('customer-1', 'order-1', {
      amount: 18.5,
      reason: 'The order arrived damaged',
    });

    expect(prisma.refundRequest.create).toHaveBeenCalledWith({
      data: {
        orderId: 'order-1',
        customerId: 'customer-1',
        amount: '18.50',
        reason: 'The order arrived damaged',
        status: RefundStatus.REQUESTED,
      },
    });
  });
});
