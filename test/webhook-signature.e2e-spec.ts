import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import express from 'express';
import type { Request } from 'express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { fixtureEmail, fixtureNamespace } from './helpers/fixtures';

describe('Stripe webhook signature (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const stamp = fixtureNamespace('webhook-signature');
  const oldSecretKey = process.env.STRIPE_SECRET_KEY;
  const oldWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let customerId = '';
  let addressId = '';
  let orderId = '';
  let paymentId = '';

  beforeAll(async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_webhook_signature_e2e';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_webhook_signature_e2e';

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

    const customer = await prisma.customer.create({
      data: {
        email: fixtureEmail(stamp, 'customer'),
        passwordHash: 'unused-webhook-test-hash',
        name: 'Webhook Signature Customer',
      },
    });
    customerId = customer.id;
    const address = await prisma.address.create({
      data: {
        customerId,
        line1: '12 Test Road',
        city: 'Colombo',
        district: 'Colombo',
        postalCode: '00100',
      },
    });
    addressId = address.id;
    const order = await prisma.order.create({
      data: {
        customerId,
        shippingAddressId: addressId,
        totalAmount: '1500.00',
        totalWeight: '500',
        shippingFee: '350.00',
      },
    });
    orderId = order.id;
    const payment = await prisma.payment.create({
      data: {
        orderId,
        gateway: 'STRIPE',
        gatewayPaymentId: `${stamp}-payment`,
        amount: '1500.00',
        currency: 'LKR',
      },
    });
    paymentId = payment.id;
  });

  afterAll(async () => {
    if (prisma) {
      if (paymentId) await prisma.payment.deleteMany({ where: { id: paymentId } });
      if (orderId) await prisma.order.deleteMany({ where: { id: orderId } });
      if (addressId) await prisma.address.deleteMany({ where: { id: addressId } });
      if (customerId) await prisma.customer.deleteMany({ where: { id: customerId } });
    }
    if (oldSecretKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = oldSecretKey;
    if (oldWebhookSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = oldWebhookSecret;
    await app?.close();
  });

  it('rejects a tampered payment success webhook without changing payment or order status', async () => {
    const event = JSON.stringify({
      id: `${stamp}-event`,
      object: 'event',
      api_version: '2024-06-20',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `${stamp}-payment`,
          object: 'payment_intent',
          amount: 150000,
          amount_received: 150000,
          currency: 'lkr',
          metadata: { orderId },
        },
      },
      livemode: false,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      type: 'payment_intent.succeeded',
    });

    await request(app.getHttpServer())
      .post('/api/webhooks/stripe')
      .set('Stripe-Signature', 't=1,v1=invalid-signature')
      .set('Content-Type', 'application/json')
      .send(event)
      .expect(400);

    await expect(
      prisma.payment.findUniqueOrThrow({ where: { id: paymentId } }),
    ).resolves.toMatchObject({
      status: 'PENDING',
    });
    await expect(prisma.order.findUniqueOrThrow({ where: { id: orderId } })).resolves.toMatchObject(
      {
        status: 'PENDING_PAYMENT',
        paymentStatus: 'PENDING',
      },
    );
  });
});
