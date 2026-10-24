import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BatchStatus } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { OutOfStockError } from '../src/inventory/inventory.errors';
import { InventoryService } from '../src/inventory/inventory.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { ProductsService } from '../src/products/products.service';
import { fixtureNamespace } from './helpers/fixtures';

/**
 * Real Postgres + Prisma.
 *
 * Verifies the SDS §4.2 + §5.3 FIFO contract end-to-end:
 *   - Earliest-expiry batch is decremented first.
 *   - Spans batches when needed; fully-drained batches → DEPLETED.
 *   - Expired batches are NOT touched, and a failed decrement rolls back.
 *   - FOR UPDATE row locks stop concurrent decrements from overselling.
 *   - The public catalogue drops a product once its valid stock reaches zero.
 */
describe('FIFO inventory (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let inventory: InventoryService;

  const stamp = fixtureNamespace('fifo');
  let variantId: string;
  const batchIds: { early: string; mid: string; late: string; expired: string } = {
    early: '',
    mid: '',
    late: '',
    expired: '',
  };

  const today = startOfTodayUtc();
  const daysFromToday = (n: number) => new Date(today.getTime() + n * 86_400_000);

  const createVariant = async (suffix: string) => {
    const product = await prisma.product.create({
      data: {
        slug: `fifo-test-${stamp}-${suffix}`,
        name: `FIFO test ${stamp} ${suffix}`,
        description: 'FIFO e2e fixture',
        category: 'jams',
        basePrice: '500.00',
        unitWeightGrams: 250,
        variants: {
          create: {
            sku: `FIFO-${stamp}-${suffix}-250G`,
            name: 'FIFO 250g',
            size: '250 g',
            price: '500.00',
            unitWeightGrams: 250,
          },
        },
      },
      include: { variants: true },
    });
    return { productId: product.id, variantId: product.variants[0].id };
  };

  const createBatch = (
    batchNumber: string,
    expiresInDays: number,
    quantity: number,
    forVariantId = variantId,
  ) =>
    prisma.productBatch.create({
      data: {
        productVariantId: forVariantId,
        batchNumber,
        manufacturedDate: daysFromToday(-180),
        expiryDate: daysFromToday(expiresInDays),
        initialQuantity: quantity,
        currentQuantity: quantity,
      },
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    inventory = app.get(InventoryService);

    ({ variantId } = await createVariant('main'));

    // Four batches: one expired that still holds stock and is still ACTIVE
    // (the expiry sweep has not run yet), three valid in mixed order.
    const expired = await createBatch('EXPIRED-001', -5, 50);
    const late = await createBatch('LATE-001', 120, 10);
    const early = await createBatch('EARLY-001', 15, 5);
    const mid = await createBatch('MID-001', 60, 7);
    batchIds.expired = expired.id;
    batchIds.early = early.id;
    batchIds.mid = mid.id;
    batchIds.late = late.id;
  });

  afterAll(async () => {
    if (prisma) {
      // Variants and batches are removed by the cascading foreign keys
      await prisma.product.deleteMany({ where: { slug: { startsWith: `fifo-test-${stamp}` } } });
    }
    await app.close();
  });

  it('availableStock sums only valid batches (excludes expired)', async () => {
    const avail = await inventory.availableStock(variantId);
    expect(avail).toBe(5 + 7 + 10); // 22 — expired excluded
  });

  it('checkStock returns sufficient=true / false at the boundary', async () => {
    expect((await inventory.checkStock(variantId, 22)).sufficient).toBe(true);
    expect((await inventory.checkStock(variantId, 23)).sufficient).toBe(false);
  });

  it('FIFO decrement: takes earliest-expiry batch first', async () => {
    const taken = await prisma.$transaction((tx) =>
      inventory.decrementForVariant(variantId, 3, tx),
    );
    expect(taken).toHaveLength(1);
    expect(taken[0]).toEqual({ batchId: batchIds.early, qtyTaken: 3, depleted: false });

    const early = await prisma.productBatch.findUnique({ where: { id: batchIds.early } });
    expect(early?.currentQuantity).toBe(2);
    expect(early?.status).toBe(BatchStatus.ACTIVE);
    // mid + late untouched
    const mid = await prisma.productBatch.findUnique({ where: { id: batchIds.mid } });
    expect(mid?.currentQuantity).toBe(7);
  });

  it('FIFO decrement spans batches and marks DEPLETED when drained', async () => {
    // remaining: early=2, mid=7, late=10  →  take 9 → drains early (2), takes 7 from mid
    const taken = await prisma.$transaction((tx) =>
      inventory.decrementForVariant(variantId, 9, tx),
    );
    expect(taken).toEqual([
      { batchId: batchIds.early, qtyTaken: 2, depleted: true },
      { batchId: batchIds.mid, qtyTaken: 7, depleted: true },
    ]);

    const early = await prisma.productBatch.findUnique({ where: { id: batchIds.early } });
    const mid = await prisma.productBatch.findUnique({ where: { id: batchIds.mid } });
    const late = await prisma.productBatch.findUnique({ where: { id: batchIds.late } });
    expect(early?.currentQuantity).toBe(0);
    expect(early?.status).toBe(BatchStatus.DEPLETED);
    expect(mid?.currentQuantity).toBe(0);
    expect(mid?.status).toBe(BatchStatus.DEPLETED);
    expect(late?.currentQuantity).toBe(10);
    expect(late?.status).toBe(BatchStatus.ACTIVE);
  });

  it('NEVER touches an expired batch and rolls back when the union is short', async () => {
    // remaining valid stock = late.currentQuantity = 10. Ask for 12 → out of stock.
    const attempt = prisma.$transaction((tx) => inventory.decrementForVariant(variantId, 12, tx));
    await expect(attempt).rejects.toBeInstanceOf(OutOfStockError);
    await expect(attempt).rejects.toMatchObject({ requested: 12, available: 10 });

    const expired = await prisma.productBatch.findUnique({ where: { id: batchIds.expired } });
    // Expired batch quantity completely untouched.
    expect(expired?.currentQuantity).toBe(50);
    expect(expired?.status).toBe(BatchStatus.ACTIVE);

    // The late batch was decremented inside the failed transaction; it must be rolled back.
    const late = await prisma.productBatch.findUnique({ where: { id: batchIds.late } });
    expect(late?.currentQuantity).toBe(10);
    expect(late?.status).toBe(BatchStatus.ACTIVE);
  });

  it('FOR UPDATE locks prevent overselling under concurrent decrements', async () => {
    const fixture = await createVariant('concurrent');
    await createBatch('CONC-001', 30, 10, fixture.variantId);

    // Three concurrent requests for 4 units against 10 in stock: only two can succeed.
    const results = await Promise.allSettled(
      [1, 2, 3].map(() =>
        prisma.$transaction((tx) => inventory.decrementForVariant(fixture.variantId, 4, tx)),
      ),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(2);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(OutOfStockError);
    expect(await inventory.availableStock(fixture.variantId)).toBe(2);
  });

  it('GET /api/products excludes products with zero valid stock', async () => {
    const products = app.get(ProductsService);
    const search = `FIFO test ${stamp} main`;
    expect((await products.list({ search, page: 1, pageSize: 24 })).total).toBe(1);

    // Drain the last valid batch; only the expired batch is left
    await prisma.$transaction((tx) => inventory.decrementForVariant(variantId, 10, tx));

    expect((await products.list({ search, page: 1, pageSize: 24 })).total).toBe(0);
  });
});

function startOfTodayUtc(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}
