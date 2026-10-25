import { ConfigService } from '@nestjs/config';
import { AuditService } from '../audit/audit.service';
import { CronLockService } from '../common/locks/cron-lock.service';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { StaleOrderCronService } from './stale-order-cron.service';

describe('StaleOrderCronService', () => {
  const now = new Date('2026-11-01T10:00:00.000Z');

  let svc: StaleOrderCronService;
  let prisma: { order: { findMany: jest.Mock }; $transaction: jest.Mock };
  let tx: { order: { updateMany: jest.Mock }; payment: { updateMany: jest.Mock } };
  let inventory: { restockOrderItems: jest.Mock };
  let audit: { record: jest.Mock };
  let locks: { runExclusive: jest.Mock };
  let timeout: string | undefined;

  const build = () =>
    new StaleOrderCronService(
      prisma as unknown as PrismaService,
      inventory as unknown as InventoryService,
      audit as unknown as AuditService,
      locks as unknown as CronLockService,
      { get: jest.fn(() => timeout) } as unknown as ConfigService,
    );

  beforeEach(() => {
    timeout = undefined;
    tx = {
      order: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      payment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    prisma = {
      order: { findMany: jest.fn().mockResolvedValue([{ id: 'order-1' }]) },
      $transaction: jest.fn((callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    };
    inventory = {
      restockOrderItems: jest
        .fn()
        .mockResolvedValue([{ batchId: 'batch-1', quantity: 2, restocked: true }]),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    locks = {
      runExclusive: jest.fn((_name: string, _ttl: number, fn: () => Promise<unknown>) => fn()),
    };
    svc = build();
  });

  it('selects PENDING_PAYMENT orders older than the 30 minute default', async () => {
    await svc.cancelStale(now);

    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: 'PENDING_PAYMENT',
          placedAt: { lt: new Date('2026-11-01T09:30:00.000Z') },
        },
      }),
    );
  });

  it('uses PENDING_ORDER_TIMEOUT_MINUTES when it is set', async () => {
    timeout = '45';
    await build().cancelStale(now);

    expect(prisma.order.findMany.mock.calls[0][0].where.placedAt).toEqual({
      lt: new Date('2026-11-01T09:15:00.000Z'),
    });
  });

  it('cancels the order, fails its pending payment, restocks and audits', async () => {
    await expect(svc.cancelStale(now)).resolves.toEqual({ cancelled: 1 });

    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', status: 'PENDING_PAYMENT' },
      data: { status: 'CANCELLED', paymentStatus: 'FAILED', cancelledAt: now },
    });
    expect(tx.payment.updateMany).toHaveBeenCalledWith({
      where: { orderId: 'order-1', status: 'PENDING' },
      data: { status: 'FAILED', processedAt: now },
    });
    expect(inventory.restockOrderItems).toHaveBeenCalledWith('order-1', tx);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'SYSTEM',
        action: 'order.cancelled',
        targetId: 'order-1',
        metadata: expect.objectContaining({ reason: 'payment_timeout', timeoutMinutes: 30 }),
      }),
    );
  });

  it('leaves an order that was paid meanwhile alone', async () => {
    tx.order.updateMany.mockResolvedValue({ count: 0 });

    await expect(svc.cancelStale(now)).resolves.toEqual({ cancelled: 0 });
    expect(inventory.restockOrderItems).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('keeps going when one order fails to cancel', async () => {
    prisma.order.findMany.mockResolvedValue([{ id: 'order-bad' }, { id: 'order-1' }]);
    prisma.$transaction
      .mockRejectedValueOnce(new Error('deadlock'))
      .mockImplementation((callback: (client: typeof tx) => Promise<unknown>) => callback(tx));

    await expect(svc.cancelStale(now)).resolves.toEqual({ cancelled: 1 });
  });

  it('runs under a ten-minute lock and skips when another instance holds it', async () => {
    await expect(svc.runScheduled()).resolves.toEqual({ cancelled: 1 });
    expect(locks.runExclusive).toHaveBeenCalledWith(
      expect.stringMatching(/^stale-orders:\d+$/),
      540,
      expect.any(Function),
    );

    prisma.order.findMany.mockClear();
    locks.runExclusive.mockResolvedValue(null);
    await expect(svc.runScheduled()).resolves.toBeNull();
    expect(prisma.order.findMany).not.toHaveBeenCalled();
  });
});
