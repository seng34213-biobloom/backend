import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import express from 'express';
import type { Request } from 'express';
import { createHash, createHmac } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { fixtureEmail, fixtureNamespace } from './helpers/fixtures';

describe('Saving a card for Subscribe & Save (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  const stamp = fixtureNamespace('payment-setup');
  const envKeys = [
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'PAYHERE_MERCHANT_ID',
    'PAYHERE_MERCHANT_SECRET',
  ];
  const oldEnv = envKeys.map((key) => [key, process.env[key]] as const);
  const webhookSecret = 'whsec_payment_setup_e2e';
  const merchantId = '1234567';
  const merchantSecret = 'payment_setup_secret';
  const returnUrl = `${process.env.STOREFRONT_URL ?? 'http://localhost:3000'}/checkout?subscribe=1`;
  const fixture = {
    customers: [] as string[],
    setupKeys: [] as string[],
    variantId: '',
    alice: {} as Awaited<ReturnType<typeof signIn>>,
    bob: {} as Awaited<ReturnType<typeof signIn>>,
  };

  const signIn = async (name: string) => {
    const agent = request.agent(app.getHttpServer());
    const csrf = (await agent.get('/api/auth/csrf').expect(200)).body.csrfToken as string;
    const email = fixtureEmail(stamp, name);
    const password = 'Sunrise2026';
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
    fixture.customers.push(registered.body.id);
    const address = await prisma.address.create({
      data: {
        customerId: registered.body.id,
        line1: '12 Temple Road',
        city: 'Kelaniya',
        district: 'Gampaha',
        postalCode: '11600',
      },
    });
    return { agent, csrf, id: registered.body.id as string, addressId: address.id };
  };

  const startSetup = (who: typeof fixture.alice, body: Record<string, unknown> = {}) =>
    who.agent
      .post('/api/payments/setup')
      .set('x-csrf-token', who.csrf)
      .send({ gateway: 'STRIPE', returnUrl, ...body });

  const completeSetup = (who: typeof fixture.alice, sessionId: string, gateway = 'PAYHERE') =>
    who.agent
      .post('/api/payments/setup/complete')
      .set('x-csrf-token', who.csrf)
      .send({ gateway, sessionId });

  // A setup PayHere has been asked for, as startSetup leaves it outside test mode
  const payHereSetupFor = async (who: typeof fixture.alice) => {
    const sessionId = `setup_${stamp}_${fixture.setupKeys.length}`;
    const key = `payments:setup:${sessionId}`;
    fixture.setupKeys.push(key);
    await redis
      .getClient()
      .set(key, JSON.stringify({ customerId: who.id, gateway: 'PAYHERE' }), 'EX', 60);
    return sessionId;
  };

  const notifyPayHere = (
    orderId: string,
    statusCode: string,
    extra: Record<string, string> = {},
  ) => {
    const md5 = (value: string) => createHash('md5').update(value).digest('hex');
    const secret = md5(merchantSecret).toUpperCase();
    return request(app.getHttpServer())
      .post('/api/webhooks/payhere')
      .send({
        merchant_id: merchantId,
        order_id: orderId,
        payment_id: '320025023469',
        payhere_amount: '0.00',
        payhere_currency: 'LKR',
        status_code: statusCode,
        md5sig: md5(`${merchantId}${orderId}0.00LKR${statusCode}${secret}`).toUpperCase(),
        ...extra,
      });
  };

  beforeAll(async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_payment_setup_e2e';
    process.env.STRIPE_WEBHOOK_SECRET = webhookSecret;
    process.env.PAYHERE_MERCHANT_ID = merchantId;
    process.env.PAYHERE_MERCHANT_SECRET = merchantSecret;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app);
    app.use(
      express.json({
        verify: (req: Request & { rawBody?: Buffer }, _res, body) => {
          if (req.originalUrl?.startsWith('/api/webhooks/')) {
            req.rawBody = Buffer.from(body);
          }
        },
      }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    redis = app.get(RedisService);

    const product = await prisma.product.create({
      data: {
        slug: `${stamp}-honey`,
        name: `${stamp} Wild Honey`,
        description: 'Payment setup fixture',
        category: 'honey',
        basePrice: '1500.00',
        unitWeightGrams: 320,
        variants: {
          create: [
            {
              sku: `${stamp}-250`,
              name: '250g',
              size: '250 g',
              price: '1500.00',
              unitWeightGrams: 320,
            },
          ],
        },
      },
      include: { variants: true },
    });
    fixture.variantId = product.variants[0].id;
    fixture.alice = await signIn('alice');
    fixture.bob = await signIn('bob');
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.subscription.deleteMany({ where: { customerId: { in: fixture.customers } } });
      await prisma.customer.deleteMany({ where: { id: { in: fixture.customers } } });
      await prisma.product.deleteMany({ where: { slug: { startsWith: stamp } } });
    }
    if (redis && fixture.setupKeys.length) await redis.getClient().del(...fixture.setupKeys);
    for (const [key, value] of oldEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await app?.close();
  });

  it('saves a card and starts a subscription priced with the discount', async () => {
    const setup = await startSetup(fixture.alice).expect(200);
    expect(setup.body.paymentToken).toMatch(/^cus_test_\w+:pm_test_\w+$/);

    const created = await fixture.alice.agent
      .post('/api/subscriptions')
      .set('x-csrf-token', fixture.alice.csrf)
      .send({
        productVariantId: fixture.variantId,
        shippingAddressId: fixture.alice.addressId,
        frequencyDays: 30,
        quantity: 2,
        paymentToken: setup.body.paymentToken,
        paymentGateway: 'STRIPE',
      })
      .expect(201);

    expect(created.body).toMatchObject({
      status: 'ACTIVE',
      discountedUnitPrice: '1350.00',
      variant: { price: '1500.00' },
    });
    const listed = await fixture.alice.agent.get('/api/subscriptions').expect(200);
    expect(listed.body[0].discountedUnitPrice).toBe('1350.00');
  });

  it('only sends the customer back to the storefront', async () => {
    await startSetup(fixture.alice, { returnUrl: 'https://evil.example.com/checkout' }).expect(400);
    await startSetup(fixture.alice, { returnUrl: 'not-a-url' }).expect(422);
    await startSetup(fixture.alice, { gateway: 'CASH' }).expect(422);
  });

  it('needs a signed-in customer', async () => {
    const agent = request.agent(app.getHttpServer());
    const csrf = (await agent.get('/api/auth/csrf').expect(200)).body.csrfToken as string;
    await agent
      .post('/api/payments/setup')
      .set('x-csrf-token', csrf)
      .send({ gateway: 'STRIPE', returnUrl })
      .expect(401);
  });

  it('completes a PayHere setup once its webhook has delivered the token', async () => {
    const sessionId = await payHereSetupFor(fixture.alice);

    await completeSetup(fixture.alice, sessionId).expect(409);
    const notified = await notifyPayHere(sessionId, '2', { customer_token: 'payhere-token-1' });
    expect(notified.body).toEqual({ status: 'applied' });

    await completeSetup(fixture.bob, sessionId).expect(404);
    await completeSetup(fixture.alice, sessionId, 'STRIPE').expect(404);
    const completed = await completeSetup(fixture.alice, sessionId).expect(200);
    expect(completed.body).toEqual({ paymentToken: 'payhere-token-1' });

    // A reloaded return page cannot create a second subscription
    await completeSetup(fixture.alice, sessionId).expect(404);
  });

  it('reports a card PayHere refused', async () => {
    const sessionId = await payHereSetupFor(fixture.alice);
    await notifyPayHere(sessionId, '-2').expect(200);
    await completeSetup(fixture.alice, sessionId).expect(400);
  });

  it('ignores a forged PayHere setup notification', async () => {
    const sessionId = await payHereSetupFor(fixture.alice);
    await notifyPayHere(sessionId, '2', {
      customer_token: 'forged-token',
      md5sig: 'A'.repeat(32),
    }).expect(400);
    await completeSetup(fixture.alice, sessionId).expect(409);
  });

  it.each(['checkout.session.completed', 'checkout.session.expired'])(
    'acknowledges a Stripe %s for a card setup so it is not retried',
    async (type) => {
      const body = JSON.stringify({
        id: `evt_${stamp}`,
        object: 'event',
        api_version: '2024-06-20',
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            id: `cs_${stamp}`,
            object: 'checkout.session',
            mode: 'setup',
            payment_status: 'no_payment_required',
            amount_total: null,
            currency: null,
          },
        },
        livemode: false,
        pending_webhooks: 1,
        request: { id: null, idempotency_key: null },
        type,
      });
      const timestamp = Math.floor(Date.now() / 1000);
      const digest = createHmac('sha256', webhookSecret)
        .update(`${timestamp}.${body}`)
        .digest('hex');

      const res = await request(app.getHttpServer())
        .post('/api/webhooks/stripe')
        .set('Stripe-Signature', `t=${timestamp},v1=${digest}`)
        .set('Content-Type', 'application/json')
        .send(body)
        .expect(200);
      expect(res.body).toEqual({ status: 'ignored' });
    },
  );
});
