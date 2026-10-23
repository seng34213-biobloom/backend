import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

type Agent = ReturnType<typeof request.agent>;
type Status = 'PENDING_PAYMENT' | 'PAID' | 'DELIVERED' | 'CANCELLED' | 'REFUNDED';

describe('Admin analytics (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const stamp = `analytics${Date.now()}`;
  const password = 'Harvest2026';
  const emails = {
    admin: `admin.${stamp}@example.com`,
    staff: `packer.${stamp}@example.com`,
    customer: `shopper.${stamp}@example.com`,
  };
  const sessions = {} as Record<'admin' | 'staff' | 'customer', Agent>;
  const ids = { customer: '', address: '', variant: '', batch: '', product: '' };

  const now = new Date();
  const dayStart = (offset: number) => {
    const d = new Date(now);
    d.setUTCHours(0, 0, 0, 0);
    return new Date(d.getTime() + offset * 86_400_000);
  };
  const isoDay = (offset: number) => dayStart(offset).toISOString().slice(0, 10);

  const signIn = async (email: string): Promise<Agent> => {
    const agent = request.agent(app.getHttpServer());
    const csrf = (await agent.get('/api/auth/csrf').expect(200)).body.csrfToken as string;
    await agent
      .post('/api/auth/login')
      .set('x-csrf-token', csrf)
      .send({ email, password })
      .expect(200);
    return agent;
  };

  // One line item of 2 jars per order, placed `offsetDays` from today
  const createOrder = (status: Status, total: string, offsetDays: number) =>
    prisma.order.create({
      data: {
        customerId: ids.customer,
        shippingAddressId: ids.address,
        status,
        totalAmount: total,
        totalWeight: '1000',
        shippingFee: '0.00',
        placedAt:
          offsetDays === 0 ? new Date(now) : new Date(dayStart(offsetDays).getTime() + 43_200_000),
        items: {
          create: {
            productVariantId: ids.variant,
            batchId: ids.batch,
            quantity: 2,
            unitPriceSnapshot: (Number(total) / 2).toFixed(2),
            lineTotal: total,
          },
        },
      },
    });

  const dashboard = async () =>
    (await sessions.admin.get('/api/admin/analytics/dashboard').expect(200)).body;
  const series = async (days: number) =>
    (await sessions.admin.get(`/api/admin/analytics/revenue-series?days=${days}`).expect(200))
      .body as Array<{ date: string; total: string }>;
  const totalOn = (points: Array<{ date: string; total: string }>, date: string) =>
    Number(points.find((p) => p.date === date)?.total);

  let before: {
    dashboard: { todayRevenue: string; pendingOrders: number };
    series: Array<{ date: string; total: string }>;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    const passwordHash = await bcrypt.hash(password, 4);
    await prisma.adminUser.createMany({
      data: [
        { email: emails.admin, passwordHash, name: 'Admin', role: 'ADMIN' },
        { email: emails.staff, passwordHash, name: 'Packer', role: 'FULFILMENT_STAFF' },
      ],
    });
    const customer = await prisma.customer.create({
      data: { email: emails.customer, passwordHash, name: 'Shopper' },
    });
    const address = await prisma.address.create({
      data: {
        customerId: customer.id,
        line1: '12 Temple Road',
        city: 'Kelaniya',
        district: 'Gampaha',
        postalCode: '11600',
      },
    });
    const product = await prisma.product.create({
      data: {
        slug: `${stamp}-jam`,
        name: `${stamp} Strawberry Jam`,
        description: 'Analytics fixture',
        category: 'jams',
        basePrice: '500.00',
        unitWeightGrams: 500,
        variants: {
          create: {
            sku: `${stamp}-500`,
            name: '500g',
            size: '500 g',
            price: '500.00',
            unitWeightGrams: 500,
          },
        },
      },
      include: { variants: true },
    });
    const batch = await prisma.productBatch.create({
      data: {
        productVariantId: product.variants[0].id,
        batchNumber: `${stamp}-B1`,
        manufacturedDate: dayStart(-30),
        expiryDate: dayStart(120),
        initialQuantity: 100,
        currentQuantity: 100,
      },
    });
    Object.assign(ids, {
      customer: customer.id,
      address: address.id,
      product: product.id,
      variant: product.variants[0].id,
      batch: batch.id,
    });

    sessions.admin = await signIn(emails.admin);
    sessions.staff = await signIn(emails.staff);
    sessions.customer = await signIn(emails.customer);

    // Baseline before our orders, so other rows in the database don't matter
    before = { dashboard: await dashboard(), series: await series(5) };

    await createOrder('PAID', '1000.00', 0);
    await createOrder('PENDING_PAYMENT', '500.00', 0);
    await createOrder('CANCELLED', '300.00', 0);
    await createOrder('DELIVERED', '700.00', -1);
    await createOrder('CANCELLED', '200.00', -3);
    await createOrder('REFUNDED', '150.00', -3);
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.order.deleteMany({ where: { customerId: ids.customer } });
      await prisma.customer.deleteMany({ where: { email: emails.customer } });
      await prisma.product.deleteMany({ where: { slug: { startsWith: stamp } } });
      await prisma.adminUser.deleteMany({ where: { email: { contains: stamp } } });
    }
    await app?.close();
  });

  it("counts today's paid orders as revenue and PAID orders as pending", async () => {
    const after = await dashboard();

    expect(Object.keys(after).sort()).toEqual([
      'activeSubscriptions',
      'batchesExpiringSoon',
      'pendingOrders',
      'todayRevenue',
    ]);
    // Only the PAID 1000.00 counts; the unpaid 500.00 and cancelled 300.00 do not
    expect(Number(after.todayRevenue) - Number(before.dashboard.todayRevenue)).toBeCloseTo(1000);
    expect(after.pendingOrders - before.dashboard.pendingOrders).toBe(1);
  });

  it('returns one point per day, zero for days whose only orders were cancelled or refunded', async () => {
    const points = await series(5);

    expect(points.map((p) => p.date)).toEqual([
      isoDay(-4),
      isoDay(-3),
      isoDay(-2),
      isoDay(-1),
      isoDay(0),
    ]);
    expect(totalOn(points, isoDay(-1)) - totalOn(before.series, isoDay(-1))).toBeCloseTo(700);
    expect(totalOn(points, isoDay(-3)) - totalOn(before.series, isoDay(-3))).toBeCloseTo(0);
    expect(totalOn(points, isoDay(0)) - totalOn(before.series, isoDay(0))).toBeCloseTo(1000);
  });

  it('defaults the revenue series to 30 days', async () => {
    const res = await sessions.admin.get('/api/admin/analytics/revenue-series').expect(200);
    expect(res.body).toHaveLength(30);
  });

  it('lists the best-selling products this month with units and revenue', async () => {
    const res = await sessions.admin.get('/api/admin/analytics/top-selling?limit=50').expect(200);
    const ours = res.body.find((p: { productId: string }) => p.productId === ids.product);

    // Paid this month: 1000.00 today plus 700.00 yesterday, when yesterday falls in this month
    const sameMonth = dayStart(-1).getUTCMonth() === dayStart(0).getUTCMonth();
    expect(ours).toEqual({
      productId: ids.product,
      productName: `${stamp} Strawberry Jam`,
      unitsSold: sameMonth ? 4 : 2,
      revenue: sameMonth ? '1700.00' : '1000.00',
    });
  });

  it('returns 403 to fulfilment staff and customers, and 401 without a token', async () => {
    for (const path of ['dashboard', 'revenue-series', 'top-selling']) {
      await sessions.staff.get(`/api/admin/analytics/${path}`).expect(403);
      await sessions.customer.get(`/api/admin/analytics/${path}`).expect(403);
      await request(app.getHttpServer()).get(`/api/admin/analytics/${path}`).expect(401);
    }
  });
});
