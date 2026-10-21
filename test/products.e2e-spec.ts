import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Products catalogue (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  // Unique marker so the tests only ever see their own fixtures
  const stamp = `catalogue${Date.now()}`;
  const category = `cat-${stamp}`;
  const slugs = { sellable: `${stamp}-jam`, soldOut: `${stamp}-chutney`, inactive: `${stamp}-old` };
  let sellableVariantId: string;
  let unsellableVariantId: string;

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const daysFromToday = (n: number) => new Date(today.getTime() + n * 86_400_000);

  const batch = (batchNumber: string, expiresInDays: number, quantity: number) => ({
    batchNumber,
    manufacturedDate: daysFromToday(-60),
    expiryDate: daysFromToday(expiresInDays),
    initialQuantity: Math.max(quantity, 1),
    currentQuantity: quantity,
  });

  const createProduct = (
    slug: string,
    name: string,
    active: boolean,
    variants: Array<{ suffix: string; grams: number; batches: ReturnType<typeof batch>[] }>,
  ) =>
    prisma.product.create({
      data: {
        slug,
        name,
        description: `${stamp} fixture`,
        category,
        basePrice: '850.00',
        unitWeightGrams: 250,
        active,
        variants: {
          create: variants.map((v) => ({
            sku: `${slug}-${v.suffix}`,
            name: `${name} ${v.suffix}`,
            size: v.suffix,
            price: '850.00',
            unitWeightGrams: v.grams,
            batches: { create: v.batches },
          })),
        },
      },
      include: { variants: true },
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    // Sellable: the 500 g variant has stock, the 250 g variant only has an expired batch
    const sellable = await createProduct(slugs.sellable, `${stamp} Strawberry Jam`, true, [
      { suffix: '500g', grams: 560, batches: [batch('J-500-1', 90, 8)] },
      { suffix: '250g', grams: 290, batches: [batch('J-250-1', -3, 20)] },
    ]);
    sellableVariantId = sellable.variants.find((v) => v.size === '500g')!.id;
    unsellableVariantId = sellable.variants.find((v) => v.size === '250g')!.id;

    // Sold out: one expired batch and one empty batch
    await createProduct(slugs.soldOut, `${stamp} Mango Chutney`, true, [
      { suffix: '250g', grams: 290, batches: [batch('C-1', -1, 5), batch('C-2', 30, 0)] },
    ]);

    // Inactive product with valid stock
    await createProduct(slugs.inactive, `${stamp} Old Recipe`, false, [
      { suffix: '250g', grams: 290, batches: [batch('O-1', 30, 10)] },
    ]);
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.product.deleteMany({ where: { slug: { startsWith: stamp } } });
    }
    await app.close();
  });

  it('GET /api/products lists only products with sellable stock', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/products')
      .query({ search: stamp, page: 1, pageSize: 24 })
      .expect(200);

    expect(res.body).toMatchObject({ page: 1, pageSize: 24, total: 1 });
    expect(res.body.items.map((p: { slug: string }) => p.slug)).toEqual([slugs.sellable]);
    // Active variants ordered by weight, including the one without stock
    expect(res.body.items[0].variants.map((v: { size: string }) => v.size)).toEqual([
      '250g',
      '500g',
    ]);
  });

  it('filters by category and searches case-insensitively', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/products')
      .query({ category, search: `${stamp} STRAWBERRY` })
      .expect(200);
    expect(res.body.total).toBe(1);

    const other = await request(app.getHttpServer())
      .get('/api/products')
      .query({ category: `${category}-other`, search: stamp })
      .expect(200);
    expect(other.body.total).toBe(0);
  });

  it('rejects invalid paging with 422', async () => {
    await request(app.getHttpServer()).get('/api/products').query({ pageSize: 500 }).expect(422);
    await request(app.getHttpServer()).get('/api/products').query({ page: 0 }).expect(422);
  });

  it('GET /api/products/:slug returns stock per variant, 0 and null when unsellable', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/products/${slugs.sellable}`)
      .expect(200);

    expect(res.body.stockByVariant).toEqual({
      [sellableVariantId]: 8,
      [unsellableVariantId]: 0,
    });
    expect(res.body.earliestExpiryByVariant[sellableVariantId]).toBe(
      daysFromToday(90).toISOString(),
    );
    expect(res.body.earliestExpiryByVariant[unsellableVariantId]).toBeNull();
  });

  it('returns 404 for an unknown or inactive slug', async () => {
    await request(app.getHttpServer()).get(`/api/products/${stamp}-missing`).expect(404);
    await request(app.getHttpServer()).get(`/api/products/${slugs.inactive}`).expect(404);
  });
});
