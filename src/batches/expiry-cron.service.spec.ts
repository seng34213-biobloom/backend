import { EventEmitter2 } from '@nestjs/event-emitter';
import { CronLockService } from '../common/locks/cron-lock.service';
import { ExpiryCronService } from './expiry-cron.service';
import { PrismaService } from '../prisma/prisma.service';

describe('ExpiryCronService', () => {
  let svc: ExpiryCronService;
  let prisma: jest.Mocked<PrismaService>;
  let events: jest.Mocked<EventEmitter2>;
  let locks: { runExclusive: jest.Mock };

  beforeEach(() => {
    prisma = {
      productBatch: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    } as unknown as jest.Mocked<PrismaService>;
    events = { emit: jest.fn() } as unknown as jest.Mocked<EventEmitter2>;
    locks = {
      runExclusive: jest.fn((_name: string, _ttl: number, fn: () => Promise<unknown>) => fn()),
    };
    svc = new ExpiryCronService(prisma, events, locks as unknown as CronLockService);
  });

  function inDays(n: number): Date {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + n);
    return d;
  }

  it('marks already-expired batches EXPIRED and emits batch.expired', async () => {
    (prisma.productBatch.findMany as jest.Mock)
      .mockResolvedValueOnce([
        {
          id: 'b-exp',
          productVariantId: 'v1',
          batchNumber: 'B001',
          expiryDate: inDays(-2),
          currentQuantity: 4,
        },
      ])
      .mockResolvedValueOnce([]); // no soon candidates

    const out = await svc.sweep();
    expect(out).toEqual({ expiredCount: 1, expiringSoonCount: 0 });
    const updateCall = (prisma.productBatch.updateMany as jest.Mock).mock.calls[0][0];
    expect(updateCall.where.id.in).toEqual(['b-exp']);
    expect(updateCall.data.status).toBe('EXPIRED');
    expect(events.emit).toHaveBeenCalledWith(
      'batch.expired',
      expect.objectContaining({ batchId: 'b-exp', currentQuantity: 4 }),
    );
  });

  it('marks within-7-day batches EXPIRING_SOON and emits with daysUntilExpiry', async () => {
    (prisma.productBatch.findMany as jest.Mock)
      .mockResolvedValueOnce([]) // no expired
      .mockResolvedValueOnce([
        {
          id: 'b-soon',
          productVariantId: 'v1',
          batchNumber: 'B002',
          expiryDate: inDays(3),
          currentQuantity: 9,
        },
      ]);

    const out = await svc.sweep();
    expect(out).toEqual({ expiredCount: 0, expiringSoonCount: 1 });
    expect(events.emit).toHaveBeenCalledWith(
      'batch.expiringSoon',
      expect.objectContaining({
        batchId: 'b-soon',
        currentQuantity: 9,
        daysUntilExpiry: 3,
      }),
    );
  });

  it('is idempotent — second pass over already-EXPIRING_SOON batches emits zero', async () => {
    (prisma.productBatch.findMany as jest.Mock).mockResolvedValue([]);
    const out = await svc.sweep();
    expect(out).toEqual({ expiredCount: 0, expiringSoonCount: 0 });
    expect(prisma.productBatch.updateMany).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('emits one event per qualifying batch', async () => {
    (prisma.productBatch.findMany as jest.Mock)
      .mockResolvedValueOnce([
        {
          id: 'a',
          productVariantId: 'v1',
          batchNumber: 'BA',
          expiryDate: inDays(-1),
          currentQuantity: 1,
        },
        {
          id: 'b',
          productVariantId: 'v1',
          batchNumber: 'BB',
          expiryDate: inDays(-5),
          currentQuantity: 2,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'c',
          productVariantId: 'v1',
          batchNumber: 'BC',
          expiryDate: inDays(5),
          currentQuantity: 7,
        },
      ]);

    await svc.sweep();
    const expiredEvents = (events.emit as jest.Mock).mock.calls.filter(
      (c) => c[0] === 'batch.expired',
    );
    const soonEvents = (events.emit as jest.Mock).mock.calls.filter(
      (c) => c[0] === 'batch.expiringSoon',
    );
    expect(expiredEvents).toHaveLength(2);
    expect(soonEvents).toHaveLength(1);
  });

  it('treats a batch expiring today as expiring soon with 0 days left', async () => {
    (prisma.productBatch.findMany as jest.Mock).mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: 'b-today',
        productVariantId: 'v1',
        batchNumber: 'BT',
        expiryDate: inDays(0),
        currentQuantity: 3,
      },
    ]);

    await svc.sweep();

    const soonQuery = (prisma.productBatch.findMany as jest.Mock).mock.calls[1][0];
    expect(soonQuery.where.status).toBe('ACTIVE');
    expect(soonQuery.where.expiryDate.gte.getTime()).toBe(inDays(0).getTime());
    expect(soonQuery.where.expiryDate.lte.getTime()).toBe(inDays(7).getTime());
    expect(events.emit).toHaveBeenCalledWith(
      'batch.expiringSoon',
      expect.objectContaining({ batchId: 'b-today', daysUntilExpiry: 0 }),
    );
  });

  it('runDaily runs the sweep', async () => {
    await expect(svc.runDaily()).resolves.toEqual({ expiredCount: 0, expiringSoonCount: 0 });
    expect(prisma.productBatch.findMany).toHaveBeenCalledTimes(2);
  });

  it('sweeps under the daily expiry lock and skips when another instance holds it', async () => {
    await expect(svc.runDaily()).resolves.toEqual({ expiredCount: 0, expiringSoonCount: 0 });
    expect(locks.runExclusive).toHaveBeenCalledWith(
      expect.stringMatching(/^expiry:\d{4}-\d{2}-\d{2}$/),
      3600,
      expect.any(Function),
    );

    (prisma.productBatch.findMany as jest.Mock).mockClear();
    locks.runExclusive.mockResolvedValue(null);
    await expect(svc.runDaily()).resolves.toBeNull();
    expect(prisma.productBatch.findMany).not.toHaveBeenCalled();
  });
});
