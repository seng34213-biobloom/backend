import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

type CustomerSession = {
  id: string;
  addressId: string;
  agent: ReturnType<typeof request.agent>;
  csrf: string;
};

describe('Customer resource ownership (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const stamp = `ownership${Date.now()}${randomUUID().replace(/-/g, '')}`;
  const password = 'OwnershipTest2026';
  const customerIds: string[] = [];
  const addressIds: string[] = [];
  let productId = '';
  let batchId = '';
  let orderId = '';
  let subscriptionId = '';
  let alice: CustomerSession;
  let bob: CustomerSession;

  const signIn = async (name: string): Promise<CustomerSession> => {
    const agent = request.agent(app.getHttpServer());
    const csrf = (await agent.get('/api/auth/csrf').expect(200)).body.csrfToken as string;
    const email = `${name}.${stamp}@example.com`;
    const registration = await agent
      .post('/api/auth/register')
      .set('x-csrf-token', csrf)
      .send({ email, password, name })
      .expect(201);
    const id = registration.body.id as string;
    customerIds.push(id);
    await agent
      .post('/api/auth/login')
      .set('x-csrf-token', csrf)
      .send({ email, password })
      .expect(200);
    const address = await agent
      .post('/api/addresses')
      .set('x-csrf-token', csrf)
      .send({
        line1: '12 Ownership Test Road',
        city: 'Colombo',
        district: 'Colombo',
        postalCode: '00100',
      })
      .expect(201);
    const addressId = address.body.id as string;
    addressIds.push(addressId);
    return { id, addressId, agent, csrf };
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    alice = await signIn('alice');
    bob = await signIn('bob');

    const product = await prisma.product.create({
      data: {
        slug: `${stamp}-product`,
        name: `${stamp} Product`,
        description: 'Customer ownership fixture',
        category: 'honey',
        basePrice: '1500.00',
        unitWeightGrams: 250,
        variants: {
          create: {
            sku: `${stamp}-250g`,
            name: '250g',
            size: '250 g',
            price: '1500.00',
            unitWeightGrams: 250,
          },
        },
      },
      include: { variants: true },
    });
    productId = product.id;
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const batch = await prisma.productBatch.create({
      data: {
        productVariantId: product.variants[0].id,
        batchNumber: `${stamp}-batch`,
        manufacturedDate: new Date(today.getTime() - 86_400_000),
        expiryDate: new Date(today.getTime() + 30 * 86_400_000),
        initialQuantity: 2,
        currentQuantity: 2,
      },
    });
    batchId = batch.id;

    await alice.agent
      .post('/api/cart/items')
      .set('x-csrf-token', alice.csrf)
      .send({ productVariantId: product.variants[0].id, quantity: 1 })
      .expect(200);

    const order = await prisma.order.create({
      data: {
        customerId: alice.id,
        shippingAddressId: alice.addressId,
        status: 'DELIVERED',
        totalAmount: '1850.00',
        totalWeight: '500',
        shippingFee: '350.00',
        deliveredAt: new Date(),
      },
    });
    orderId = order.id;

    const subscription = await alice.agent
      .post('/api/subscriptions')
      .set('x-csrf-token', alice.csrf)
      .send({
        productVariantId: product.variants[0].id,
        shippingAddressId: alice.addressId,
        frequencyDays: 30,
        quantity: 1,
        paymentToken: 'pm_test_4242424242424242',
        paymentGateway: 'STRIPE',
      })
      .expect(201);
    subscriptionId = subscription.body.id as string;
  });

  afterAll(async () => {
    if (prisma) {
      if (orderId) {
        await prisma.refundRequest.deleteMany({ where: { orderId } });
        await prisma.order.deleteMany({ where: { id: orderId } });
      }
      if (customerIds.length > 0) {
        await prisma.subscription.deleteMany({ where: { customerId: { in: customerIds } } });
        await prisma.cartItem.deleteMany({ where: { customerId: { in: customerIds } } });
      }
      if (batchId) await prisma.productBatch.deleteMany({ where: { id: batchId } });
      if (productId) await prisma.product.deleteMany({ where: { id: productId } });
      if (addressIds.length > 0)
        await prisma.address.deleteMany({ where: { id: { in: addressIds } } });
      if (customerIds.length > 0)
        await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
    }
    await app?.close();
  });

  it('scopes address and cart operations to their customer', async () => {
    const bobAddresses = (await bob.agent.get('/api/addresses').expect(200)).body as Array<{
      id: string;
    }>;
    expect(bobAddresses.map((address) => address.id)).not.toContain(alice.addressId);
    await bob.agent
      .patch(`/api/addresses/${alice.addressId}/default`)
      .set('x-csrf-token', bob.csrf)
      .expect(404);

    const aliceCart = (await alice.agent.get('/api/cart').expect(200)).body as {
      items: Array<{ id: string }>;
    };
    const itemId = aliceCart.items[0].id;
    await bob.agent
      .patch(`/api/cart/items/${itemId}`)
      .set('x-csrf-token', bob.csrf)
      .send({ quantity: 2 })
      .expect(403);
    await bob.agent.delete(`/api/cart/items/${itemId}`).set('x-csrf-token', bob.csrf).expect(403);
  });

  it("rejects access to another customer's order and refund flow", async () => {
    await bob.agent.get(`/api/orders/${orderId}`).expect(403);
    await bob.agent
      .post(`/api/orders/${orderId}/refund-requests`)
      .set('x-csrf-token', bob.csrf)
      .send({ reason: 'Requesting a refund for this order' })
      .expect(403);
    await expect(prisma.refundRequest.count({ where: { orderId } })).resolves.toBe(0);
  });

  it('rejects changes to another customer’s subscription', async () => {
    await bob.agent
      .patch(`/api/subscriptions/${subscriptionId}/pause`)
      .set('x-csrf-token', bob.csrf)
      .expect(403);
  });
});
