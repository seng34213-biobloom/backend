import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import express from 'express';
import type { Request } from 'express';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { fixtureEmail, fixtureNamespace } from './helpers/fixtures';

type Agent = ReturnType<typeof request.agent>;

interface CustomerSession {
  id: string;
  agent: Agent;
  csrf: string;
  addressId: string;
}

describe('Atomic checkout (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const stamp = fixtureNamespace('checkout');
  const password = 'Sunrise2026';
  const stripeWebhookSecret = 'whsec_checkout_e2e_test_secret';
  const fixture = {
    customers: [] as string[],
    productId: '',
    variantId: '',
    lastUnitVariantId: '',
    batchIds: [] as string[],
    alice: undefined as unknown as CustomerSession,
    bob: undefined as unknown as CustomerSession,
  };

  const signIn = async (name: string): Promise<CustomerSession> => {
    const agent = request.agent(app.getHttpServer());
    const csrf = (await agent.get('/api/auth/csrf').expect(200)).body.csrfToken as string;
    const email = fixtureEmail(stamp, name);
    const registered = await agent
      .post('/api/auth/register')
      .set('x-csrf-token', csrf)
      .send({ email, password, name })
      .expect(201);
    await agent
      .post('/api/auth/login')
      .set('x-csrf-token', csrf)
      .send({ email, password })
      .expect(200);
    const id = registered.body.id as string;
    fixture.customers.push(id);
    const address = await agent
      .post('/api/addresses')
      .set('x-csrf-token', csrf)
      .send({
        line1: '12 Temple Road',
        city: 'Colombo',
        district: 'Colombo',
        postalCode: '00100',
      })
      .expect(201);
    return { id, agent, csrf, addressId: address.body.id as string };
  };

  const addCartItem = (session: CustomerSession, variantId: string, quantity: number) =>
    session.agent
      .post('/api/cart/items')
      .set('x-csrf-token', session.csrf)
      .send({ productVariantId: variantId, quantity });

  const checkout = (session: CustomerSession, shippingAddressId: string) =>
    session.agent
      .post('/api/checkout')
      .set('x-csrf-token', session.csrf)
      .send({ shippingAddressId });

  const daysFromToday = (days: number): Date => {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    return new Date(today.getTime() + days * 86_400_000);
  };

  beforeAll(async () => {
    process.env.STRIPE_SECRET_KEY ??= 'sk_test_checkout_e2e';
    process.env.STRIPE_WEBHOOK_SECRET ??= stripeWebhookSecret;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app);
    const captureRawBody = (req: Request & { rawBody?: Buffer }, _res: unknown, body: Buffer) => {
      if (req.originalUrl?.startsWith('/api/webhooks/')) {
        req.rawBody = Buffer.from(body);
      }
    };
    app.use(express.json({ verify: captureRawBody }));
    app.use(express.urlencoded({ extended: true, verify: captureRawBody }));
    await app.init();
    prisma = app.get(PrismaService);

    fixture.alice = await signIn('alice');
    fixture.bob = await signIn('bob');

    const product = await prisma.product.create({
      data: {
        slug: `${stamp}-honey`,
        name: `${stamp} Wild Honey`,
        description: 'Checkout fixture',
        category: 'honey',
        basePrice: '1500.00',
        unitWeightGrams: 300,
        variants: {
          create: [
            {
              sku: `${stamp}-regular`,
              name: 'Wild Honey 300g',
              size: '300 g',
              price: '1500.00',
              unitWeightGrams: 300,
            },
            {
              sku: `${stamp}-last-unit`,
              name: 'Wild Honey 300g limited',
              size: '300 g',
              price: '1500.00',
              unitWeightGrams: 300,
            },
          ],
        },
      },
      include: { variants: true },
    });
    fixture.productId = product.id;
    fixture.variantId = product.variants[0].id;
    fixture.lastUnitVariantId = product.variants[1].id;

    const firstBatch = await prisma.productBatch.create({
      data: {
        productVariantId: fixture.variantId,
        batchNumber: `${stamp}-first`,
        manufacturedDate: daysFromToday(-20),
        expiryDate: daysFromToday(30),
        initialQuantity: 2,
        currentQuantity: 2,
      },
    });
    const secondBatch = await prisma.productBatch.create({
      data: {
        productVariantId: fixture.variantId,
        batchNumber: `${stamp}-second`,
        manufacturedDate: daysFromToday(-10),
        expiryDate: daysFromToday(60),
        initialQuantity: 3,
        currentQuantity: 3,
      },
    });
    const lastUnitBatch = await prisma.productBatch.create({
      data: {
        productVariantId: fixture.lastUnitVariantId,
        batchNumber: `${stamp}-last`,
        manufacturedDate: daysFromToday(-5),
        expiryDate: daysFromToday(90),
        initialQuantity: 1,
        currentQuantity: 1,
      },
    });
    fixture.batchIds = [firstBatch.id, secondBatch.id, lastUnitBatch.id];
  });

  afterAll(async () => {
    if (prisma && fixture.customers.length > 0) {
      const orders = await prisma.order.findMany({
        where: { customerId: { in: fixture.customers } },
        select: { id: true },
      });
      const orderIds = orders.map((order) => order.id);
      if (orderIds.length > 0) {
        await prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
        await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
      }
      await prisma.cartItem.deleteMany({ where: { customerId: { in: fixture.customers } } });
      await prisma.productBatch.deleteMany({ where: { id: { in: fixture.batchIds } } });
      await prisma.product.deleteMany({ where: { id: fixture.productId } });
      await prisma.address.deleteMany({ where: { customerId: { in: fixture.customers } } });
      await prisma.customer.deleteMany({ where: { id: { in: fixture.customers } } });
    }
    await app?.close();
  });

  it('creates a quote and atomically checks out with FIFO and price snapshots', async () => {
    await addCartItem(fixture.alice, fixture.variantId, 4).expect(200);

    const quote = await fixture.alice.agent.get('/api/checkout/quote').expect(200);
    expect(quote.body).toMatchObject({
      subtotal: '6000.00',
      shippingFee: '750.00',
      total: '6750.00',
      totalWeightG: 1200,
      shippingBracket: '1–2 kg',
    });

    const response = await checkout(fixture.alice, fixture.alice.addressId).expect(201);
    expect(response.body.order).toMatchObject({
      status: 'PENDING_PAYMENT',
      totalAmount: '6750.00',
      totalWeightG: 1200,
      shippingFee: '750.00',
      currency: 'LKR',
    });
    expect(response.body.payment).toMatchObject({
      gateway: 'STRIPE',
      amount: '6750.00',
      currency: 'LKR',
    });
    expect(response.body.payment.gatewayPaymentId).toMatch(/^pi_test_/);

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: response.body.order.id as string },
      include: { items: true, payments: true },
    });
    expect(order.items).toHaveLength(2);
    expect(order.items.map((item) => item.quantity).sort()).toEqual([2, 2]);
    expect(order.items.map((item) => item.batchId).sort()).toEqual(
      fixture.batchIds.slice(0, 2).sort(),
    );
    expect(order.items.every((item) => item.unitPriceSnapshot.toString() === '1500')).toBe(true);
    expect(order.payments).toHaveLength(1);

    const remaining = await prisma.productBatch.findMany({
      where: { id: { in: fixture.batchIds.slice(0, 2) } },
      orderBy: { expiryDate: 'asc' },
    });
    expect(remaining.map((batch) => batch.currentQuantity)).toEqual([0, 1]);
    expect((await fixture.alice.agent.get('/api/cart').expect(200)).body.items).toHaveLength(0);

    const eventBody = JSON.stringify({
      id: `evt_${stamp}`,
      object: 'event',
      api_version: '2024-06-20',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: response.body.payment.gatewayPaymentId,
          object: 'payment_intent',
          amount: 675000,
          amount_received: 675000,
          currency: 'lkr',
        },
      },
      livemode: false,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      type: 'payment_intent.succeeded',
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac('sha256', stripeWebhookSecret)
      .update(`${timestamp}.${eventBody}`)
      .digest('hex');
    const webhookSignature = `t=${timestamp},v1=${signature}`;
    const webhook = await request(app.getHttpServer())
      .post('/api/webhooks/stripe')
      .set('Stripe-Signature', webhookSignature)
      .set('Content-Type', 'application/json')
      .send(eventBody)
      .expect(200);
    expect(webhook.body).toMatchObject({ status: 'applied', paymentStatus: 'PAID' });
    await expect(
      prisma.order.findUniqueOrThrow({ where: { id: response.body.order.id as string } }),
    ).resolves.toMatchObject({ status: 'PAID', paymentStatus: 'PAID' });

    const duplicate = await request(app.getHttpServer())
      .post('/api/webhooks/stripe')
      .set('Stripe-Signature', webhookSignature)
      .set('Content-Type', 'application/json')
      .send(eventBody)
      .expect(200);
    expect(duplicate.body).toMatchObject({ status: 'duplicate', paymentStatus: 'PAID' });
  });

  it('validates empty carts and unknown, malformed, or foreign addresses before ordering', async () => {
    await checkout(fixture.alice, fixture.alice.addressId).expect(400);
    await checkout(fixture.alice, 'not-a-uuid').expect(422);
    await checkout(fixture.alice, '00000000-0000-4000-8000-000000000001').expect(404);
    await checkout(fixture.alice, fixture.bob.addressId).expect(403);
    expect(await prisma.order.count({ where: { customerId: fixture.alice.id } })).toBe(1);
  });

  it('rejects a deactivated cart variant without creating an order', async () => {
    await prisma.cartItem.create({
      data: {
        customerId: fixture.alice.id,
        productVariantId: fixture.lastUnitVariantId,
        quantity: 1,
      },
    });
    await prisma.productVariant.update({
      where: { id: fixture.lastUnitVariantId },
      data: { active: false },
    });
    const before = await prisma.order.count({ where: { customerId: fixture.alice.id } });

    await checkout(fixture.alice, fixture.alice.addressId).expect(400);

    expect(await prisma.order.count({ where: { customerId: fixture.alice.id } })).toBe(before);
    await prisma.cartItem.deleteMany({ where: { customerId: fixture.alice.id } });
  });

  it('allows exactly one of two customers to buy the last unit', async () => {
    await prisma.productVariant.update({
      where: { id: fixture.lastUnitVariantId },
      data: { active: true },
    });
    await Promise.all([
      addCartItem(fixture.alice, fixture.lastUnitVariantId, 1).expect(200),
      addCartItem(fixture.bob, fixture.lastUnitVariantId, 1).expect(200),
    ]);

    const results = await Promise.all([
      checkout(fixture.alice, fixture.alice.addressId),
      checkout(fixture.bob, fixture.bob.addressId),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);

    const batch = await prisma.productBatch.findUniqueOrThrow({
      where: { id: fixture.batchIds[2] },
    });
    expect(batch.currentQuantity).toBe(0);
    const orders = await prisma.order.count({
      where: {
        customerId: { in: [fixture.alice.id, fixture.bob.id] },
        items: { some: { productVariantId: fixture.lastUnitVariantId } },
      },
    });
    expect(orders).toBe(1);
  });
});
