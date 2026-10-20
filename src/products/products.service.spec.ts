import { NotFoundException } from '@nestjs/common';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProductsService } from './products.service';

const decimal = (value: string) => ({ toString: () => value });

const productRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'p1',
  slug: 'wild-honey',
  name: 'Wild Honey',
  description: 'Raw forest honey',
  category: 'honey',
  basePrice: decimal('1500.00'),
  unitWeightGrams: 320,
  active: true,
  variants: [
    {
      id: 'v-small',
      sku: 'HONEY-250',
      name: 'Wild Honey 250g',
      size: '250 g',
      price: decimal('1500.00'),
      unitWeightGrams: 320,
    },
    {
      id: 'v-large',
      sku: 'HONEY-500',
      name: 'Wild Honey 500g',
      size: '500 g',
      price: decimal('2800.00'),
      unitWeightGrams: 600,
    },
  ],
  ...overrides,
});

describe('ProductsService', () => {
  let svc: ProductsService;
  let prisma: jest.Mocked<PrismaService>;
  let inventory: jest.Mocked<InventoryService>;

  beforeEach(() => {
    prisma = {
      product: {
        count: jest.fn().mockResolvedValue(1),
        findMany: jest.fn().mockResolvedValue([productRow()]),
        findUnique: jest.fn(),
      },
      productBatch: { findFirst: jest.fn() },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    } as unknown as jest.Mocked<PrismaService>;
    inventory = { availableStock: jest.fn() } as unknown as jest.Mocked<InventoryService>;
    svc = new ProductsService(prisma, inventory);
  });

  describe('list', () => {
    it('only lists active products with an active variant holding a valid batch', async () => {
      await svc.list({ page: 1, pageSize: 24 });

      const args = (prisma.product.findMany as jest.Mock).mock.calls[0][0];
      expect(args.where.active).toBe(true);
      expect(args.where.category).toBeUndefined();
      expect(args.where.OR).toBeUndefined();
      const batchFilter = args.where.variants.some.batches.some;
      expect(args.where.variants.some.active).toBe(true);
      expect(batchFilter.status).toEqual({ not: 'DEPLETED' });
      expect(batchFilter.currentQuantity).toEqual({ gt: 0 });
      expect(batchFilter.expiryDate.gte).toBeInstanceOf(Date);
      expect(args.orderBy).toEqual({ name: 'asc' });
      expect(args.include.variants.orderBy).toEqual({ unitWeightGrams: 'asc' });
      // count and page must use the same filter
      expect((prisma.product.count as jest.Mock).mock.calls[0][0].where).toBe(args.where);
    });

    it('adds category and case-insensitive search filters and pages the results', async () => {
      await svc.list({ category: 'honey', search: 'forest', page: 3, pageSize: 10 });

      const args = (prisma.product.findMany as jest.Mock).mock.calls[0][0];
      expect(args.where.category).toBe('honey');
      expect(args.where.OR).toEqual([
        { name: { contains: 'forest', mode: 'insensitive' } },
        { description: { contains: 'forest', mode: 'insensitive' } },
      ]);
      expect(args.skip).toBe(20);
      expect(args.take).toBe(10);
    });

    it('returns items with prices as strings plus paging metadata', async () => {
      const out = await svc.list({ page: 1, pageSize: 24 });

      expect(out).toMatchObject({ page: 1, pageSize: 24, total: 1 });
      expect(out.items[0]).toMatchObject({
        slug: 'wild-honey',
        basePrice: '1500.00',
        unitWeightGrams: 320,
      });
      expect(out.items[0].variants.map((v) => v.price)).toEqual(['1500.00', '2800.00']);
    });
  });

  describe('getBySlug', () => {
    it('throws NotFoundException for an unknown slug', async () => {
      (prisma.product.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(svc.getBySlug('missing')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws NotFoundException for an inactive product', async () => {
      (prisma.product.findUnique as jest.Mock).mockResolvedValue(productRow({ active: false }));
      await expect(svc.getBySlug('wild-honey')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns live stock and earliest expiry per variant, 0 and null when unsellable', async () => {
      (prisma.product.findUnique as jest.Mock).mockResolvedValue(productRow());
      (inventory.availableStock as jest.Mock).mockImplementation(async (variantId: string) =>
        variantId === 'v-small' ? 12 : 0,
      );
      (prisma.productBatch.findFirst as jest.Mock).mockImplementation(
        async ({ where }: { where: { productVariantId: string } }) =>
          where.productVariantId === 'v-small' ? { expiryDate: new Date('2027-01-31') } : null,
      );

      const out = await svc.getBySlug('wild-honey');

      expect(out.stockByVariant).toEqual({ 'v-small': 12, 'v-large': 0 });
      expect(out.earliestExpiryByVariant).toEqual({
        'v-small': '2027-01-31T00:00:00.000Z',
        'v-large': null,
      });
      expect(out.variants).toHaveLength(2);
    });
  });
});
