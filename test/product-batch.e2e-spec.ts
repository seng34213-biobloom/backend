import { randomUUID } from 'crypto';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Product batches (integration)', () => {
  const prisma = new PrismaService();
  // Unique suffix so the test never collides with existing rows
  const suffix = randomUUID().slice(0, 8);
  let productId: string;
  let variantId: string;

  const batch = (batchNumber: string, expiryDate: string) => ({
    productVariantId: variantId,
    batchNumber,
    manufacturedDate: new Date('2026-10-01'),
    expiryDate: new Date(expiryDate),
    initialQuantity: 50,
    currentQuantity: 50,
  });

  beforeAll(async () => {
    await prisma.onModuleInit();

    const product = await prisma.product.create({
      data: {
        name: 'Wild Forest Honey',
        slug: `wild-forest-honey-${suffix}`,
        description: 'Raw honey from the Sinharaja buffer zone',
        basePrice: '1500.00',
        unitWeightGrams: 320,
        category: 'honey',
        variants: {
          create: {
            sku: `HONEY-250-${suffix}`,
            name: 'Wild Forest Honey 250g',
            size: '250g',
            price: '1500.00',
            unitWeightGrams: 320,
          },
        },
      },
      include: { variants: true },
    });

    productId = product.id;
    variantId = product.variants[0].id;
  });

  afterAll(async () => {
    // Variants and batches are removed by the cascading foreign keys
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.onModuleDestroy();
  });

  it('returns batches of a variant ordered by expiry date (FIFO)', async () => {
    await prisma.productBatch.createMany({
      data: [
        batch('B-LATE', '2027-06-30'),
        batch('B-EARLY', '2027-01-31'),
        batch('B-MID', '2027-03-31'),
      ],
    });

    const batches = await prisma.productBatch.findMany({
      where: { productVariantId: variantId },
      orderBy: { expiryDate: 'asc' },
    });

    expect(batches.map((b) => b.batchNumber)).toEqual(['B-EARLY', 'B-MID', 'B-LATE']);
    expect(batches.every((b) => b.status === 'ACTIVE')).toBe(true);
  });

  it('rejects a batch with a negative quantity', async () => {
    await expect(
      prisma.productBatch.create({
        data: { ...batch('B-NEGATIVE', '2027-12-31'), currentQuantity: -1 },
      }),
    ).rejects.toThrow(/product_batch_quantity_check/);
  });

  it('rejects a batch that expires before it was manufactured', async () => {
    await expect(
      prisma.productBatch.create({ data: batch('B-BAD-DATES', '2026-09-01') }),
    ).rejects.toThrow(/product_batch_dates_check/);
  });

  it('rejects a duplicate batch number for the same variant', async () => {
    await prisma.productBatch.create({ data: batch('B-DUPLICATE', '2027-08-31') });

    await expect(
      prisma.productBatch.create({ data: batch('B-DUPLICATE', '2027-09-30') }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});
