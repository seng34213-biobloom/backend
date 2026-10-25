import { InventoryService } from './inventory.service';
import { OutOfStockError } from './inventory.errors';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Unit tests for InventoryService. The real `$queryRaw` / FOR UPDATE
 * semantics need a live Postgres — that's covered by test/fifo.e2e-spec.ts.
 * Here we exercise the in-memory logic that walks the locked batches and
 * updates each one in FIFO order.
 */
describe('InventoryService', () => {
  let svc: InventoryService;
  let prisma: jest.Mocked<PrismaService>;

  beforeEach(() => {
    prisma = {
      productBatch: {
        aggregate: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn(),
      },
      orderItem: { findMany: jest.fn() },
      $queryRaw: jest.fn(),
    } as unknown as jest.Mocked<PrismaService>;
    svc = new InventoryService(prisma);
  });

  describe('availableStock', () => {
    it('sums non-depleted non-expired batches', async () => {
      (prisma.productBatch.aggregate as jest.Mock).mockResolvedValue({
        _sum: { currentQuantity: 42 },
      });
      const out = await svc.availableStock('v1');
      expect(out).toBe(42);
      const args = (prisma.productBatch.aggregate as jest.Mock).mock.calls[0][0];
      expect(args.where.productVariantId).toBe('v1');
      expect(args.where.status).toEqual({ not: 'DEPLETED' });
      expect(args.where.currentQuantity).toEqual({ gt: 0 });
      expect(args.where.expiryDate.gte).toBeInstanceOf(Date);
    });

    it('returns 0 when no valid batches exist', async () => {
      (prisma.productBatch.aggregate as jest.Mock).mockResolvedValue({
        _sum: { currentQuantity: null },
      });
      expect(await svc.availableStock('v1')).toBe(0);
    });
  });

  describe('checkStock', () => {
    it('returns sufficient=true when available >= qty', async () => {
      (prisma.productBatch.aggregate as jest.Mock).mockResolvedValue({
        _sum: { currentQuantity: 10 },
      });
      expect(await svc.checkStock('v1', 5)).toEqual({ available: 10, sufficient: true });
    });

    it('returns sufficient=false when available < qty', async () => {
      (prisma.productBatch.aggregate as jest.Mock).mockResolvedValue({
        _sum: { currentQuantity: 3 },
      });
      expect(await svc.checkStock('v1', 5)).toEqual({ available: 3, sufficient: false });
    });
  });

  describe('decrementForVariant — FIFO semantics', () => {
    function mockLocked(rows: Array<{ id: string; currentQuantity: number; expiryDate: Date }>) {
      (prisma.$queryRaw as jest.Mock).mockResolvedValue(
        rows.map((r) => ({
          id: r.id,
          productVariantId: 'v1',
          batchNumber: `B-${r.id}`,
          manufacturedDate: new Date('2026-01-01'),
          expiryDate: r.expiryDate,
          initialQuantity: r.currentQuantity,
          currentQuantity: r.currentQuantity,
          status: 'ACTIVE',
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
      );
    }

    it('takes everything from the earliest batch when it has enough', async () => {
      mockLocked([
        { id: 'b1-early', currentQuantity: 10, expiryDate: new Date('2026-06-01') },
        { id: 'b2-later', currentQuantity: 10, expiryDate: new Date('2026-08-01') },
      ]);
      const out = await svc.decrementForVariant('v1', 5, prisma);
      expect(out).toEqual([{ batchId: 'b1-early', qtyTaken: 5, depleted: false }]);
      expect((prisma.productBatch.update as jest.Mock).mock.calls).toHaveLength(1);
      const updateArgs = (prisma.productBatch.update as jest.Mock).mock.calls[0][0];
      expect(updateArgs.where.id).toBe('b1-early');
      expect(updateArgs.data.currentQuantity).toBe(5);
      expect(updateArgs.data.status).toBeUndefined();
    });

    it('spans across batches when earliest is insufficient (SDS §5.3 atomicity)', async () => {
      mockLocked([
        { id: 'b1-early', currentQuantity: 5, expiryDate: new Date('2026-06-01') },
        { id: 'b2-mid', currentQuantity: 7, expiryDate: new Date('2026-07-15') },
        { id: 'b3-late', currentQuantity: 10, expiryDate: new Date('2026-09-01') },
      ]);
      const out = await svc.decrementForVariant('v1', 9, prisma);
      expect(out).toEqual([
        { batchId: 'b1-early', qtyTaken: 5, depleted: true },
        { batchId: 'b2-mid', qtyTaken: 4, depleted: false },
      ]);
      expect((prisma.productBatch.update as jest.Mock).mock.calls).toHaveLength(2);
      // First update: earliest batch fully depleted → status=DEPLETED
      const u1 = (prisma.productBatch.update as jest.Mock).mock.calls[0][0];
      expect(u1.where.id).toBe('b1-early');
      expect(u1.data.currentQuantity).toBe(0);
      expect(u1.data.status).toBe('DEPLETED');
      // Second update: mid batch partial → currentQuantity reduced, no status change
      const u2 = (prisma.productBatch.update as jest.Mock).mock.calls[1][0];
      expect(u2.where.id).toBe('b2-mid');
      expect(u2.data.currentQuantity).toBe(3);
      expect(u2.data.status).toBeUndefined();
    });

    it('throws OutOfStockError when union of batches is insufficient', async () => {
      mockLocked([
        { id: 'b1', currentQuantity: 5, expiryDate: new Date('2026-06-01') },
        { id: 'b2', currentQuantity: 3, expiryDate: new Date('2026-07-01') },
      ]);
      await expect(svc.decrementForVariant('v1', 20, prisma)).rejects.toBeInstanceOf(
        OutOfStockError,
      );
    });

    it('throws OutOfStockError with NO updates when zero valid batches found', async () => {
      mockLocked([]);
      await expect(svc.decrementForVariant('v1', 1, prisma)).rejects.toBeInstanceOf(
        OutOfStockError,
      );
      expect(prisma.productBatch.update).not.toHaveBeenCalled();
    });

    it('rejects non-positive qty before touching the DB', async () => {
      await expect(svc.decrementForVariant('v1', 0, prisma)).rejects.toThrow(/positive qty/);
      await expect(svc.decrementForVariant('v1', -5, prisma)).rejects.toThrow(/positive qty/);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });

  describe('decrementBatch — refund restock primitive', () => {
    it('decrements a single specific batch and marks DEPLETED when zero', async () => {
      (prisma.productBatch.findUnique as jest.Mock).mockResolvedValue({
        id: 'b1',
        productVariantId: 'v1',
        currentQuantity: 5,
      });
      const out = await svc.decrementBatch('b1', 5, prisma);
      expect(out).toEqual({ batchId: 'b1', qtyTaken: 5, depleted: true });
      const updateArgs = (prisma.productBatch.update as jest.Mock).mock.calls[0][0];
      expect(updateArgs.data.currentQuantity).toBe(0);
      expect(updateArgs.data.status).toBe('DEPLETED');
    });

    it('throws OutOfStockError when batch has less than qty', async () => {
      (prisma.productBatch.findUnique as jest.Mock).mockResolvedValue({
        id: 'b1',
        productVariantId: 'v1',
        currentQuantity: 2,
      });
      await expect(svc.decrementBatch('b1', 5, prisma)).rejects.toBeInstanceOf(OutOfStockError);
    });

    it('decrements part of a batch without changing its status', async () => {
      (prisma.productBatch.findUnique as jest.Mock).mockResolvedValue({
        id: 'b1',
        productVariantId: 'v1',
        currentQuantity: 5,
      });
      const out = await svc.decrementBatch('b1', 2, prisma);
      expect(out).toEqual({ batchId: 'b1', qtyTaken: 2, depleted: false });
      const updateArgs = (prisma.productBatch.update as jest.Mock).mock.calls[0][0];
      expect(updateArgs.data.currentQuantity).toBe(3);
      expect(updateArgs.data.status).toBeUndefined();
    });

    it('throws when the batch does not exist', async () => {
      (prisma.productBatch.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(svc.decrementBatch('missing', 1, prisma)).rejects.toThrow(/not found/);
      expect(prisma.productBatch.update).not.toHaveBeenCalled();
    });
  });

  describe('restockOrderItems', () => {
    it('restocks unexpired batches and skips expired or missing batches', async () => {
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      (prisma.orderItem.findMany as jest.Mock).mockResolvedValue([
        { batchId: 'fresh', quantity: 2 },
        { batchId: 'expired', quantity: 1 },
        { batchId: 'missing', quantity: 1 },
      ]);
      (prisma.productBatch.findUnique as jest.Mock)
        .mockResolvedValueOnce({
          id: 'fresh',
          currentQuantity: 3,
          expiryDate: new Date(today.getTime() + 86_400_000),
          status: 'DEPLETED',
        })
        .mockResolvedValueOnce({
          id: 'expired',
          currentQuantity: 3,
          expiryDate: new Date(today.getTime() - 86_400_000),
          status: 'EXPIRED',
        })
        .mockResolvedValueOnce(null);

      await expect(svc.restockOrderItems('order-1', prisma)).resolves.toEqual([
        { batchId: 'fresh', quantity: 2, restocked: true },
        { batchId: 'expired', quantity: 1, restocked: false },
        { batchId: 'missing', quantity: 1, restocked: false },
      ]);
      expect(prisma.productBatch.update).toHaveBeenCalledTimes(1);
      expect(prisma.productBatch.update).toHaveBeenCalledWith({
        where: { id: 'fresh' },
        data: { currentQuantity: { increment: 2 }, status: 'ACTIVE' },
      });
    });
  });
});
