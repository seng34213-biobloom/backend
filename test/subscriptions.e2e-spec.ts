import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenCipherService } from '../src/subscriptions/token-cipher.service';

type Agent = ReturnType<typeof request.agent>;

describe('Subscribe & Save (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const stamp = `subs${Date.now()}`;
  const paymentToken = 'pm_test_4242424242424242';
  const fixture = {
    variantId: '',
    inactiveVariantId: '',
    customers: [] as string[],
    alice: { agent: undefined as unknown as Agent, csrf: '', addressId: '' },
    bob: { agent: undefined as unknown as Agent, csrf: '', addressId: '' },
  };

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const daysFromToday = (n: number) => new Date(today.getTime() + n * 86_400_000).toISOString();

  // Registers and signs in a customer; the agent keeps the auth and CSRF cookies
  const signIn = async (name: string) => {
    const agent = request.agent(app.getHttpServer());
    const csrf = (await agent.get('/api/auth/csrf').expect(200)).body.csrfToken as string;
    const email = `${name}.${stamp}@example.com`;
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
    return { agent, csrf, addressId: address.id };
  };

  const subscribe = (who: typeof fixture.alice, body: Record<string, unknown> = {}) =>
    who.agent
      .post('/api/subscriptions')
      .set('x-csrf-token', who.csrf)
      .send({
        productVariantId: fixture.variantId,
        shippingAddressId: who.addressId,
        frequencyDays: 30,
        quantity: 2,
        paymentToken,
        paymentGateway: 'STRIPE',
        ...body,
      });

  const act = (who: typeof fixture.alice, id: string, action: string) =>
    who.agent.patch(`/api/subscriptions/${id}/${action}`).set('x-csrf-token', who.csrf);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    const product = await prisma.product.create({
      data: {
        slug: `${stamp}-honey`,
        name: `${stamp} Wild Honey`,
        description: 'Subscription fixture',
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
            {
              sku: `${stamp}-500`,
              name: '500g',
              size: '500 g',
              price: '2800.00',
              unitWeightGrams: 600,
              active: false,
            },
          ],
        },
      },
      include: { variants: true },
    });
    fixture.variantId = product.variants.find((v) => v.active)!.id;
    fixture.inactiveVariantId = product.variants.find((v) => !v.active)!.id;

    fixture.alice = await signIn('alice');
    fixture.bob = await signIn('bob');
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.subscription.deleteMany({ where: { customerId: { in: fixture.customers } } });
      await prisma.customer.deleteMany({ where: { id: { in: fixture.customers } } });
      await prisma.product.deleteMany({ where: { slug: { startsWith: stamp } } });
    }
    await app?.close();
  });

  it('POST /api/subscriptions creates an ACTIVE subscription with the token encrypted', async () => {
    const res = await subscribe(fixture.alice).expect(201);

    expect(res.body).toMatchObject({
      status: 'ACTIVE',
      discountRate: '0.1000',
      frequencyDays: 30,
      quantity: 2,
      nextBillingDate: daysFromToday(30),
      paymentGateway: 'STRIPE',
    });
    expect(JSON.stringify(res.body)).not.toContain(paymentToken);
    expect(res.body).not.toHaveProperty('paymentTokenEncrypted');

    // Stored as pgcrypto ciphertext that decrypts back to the original token
    const stored = await prisma.subscription.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(Buffer.from(stored.paymentTokenEncrypted).toString('latin1')).not.toContain(
      paymentToken,
    );
    await expect(app.get(TokenCipherService).decrypt(stored.paymentTokenEncrypted)).resolves.toBe(
      paymentToken,
    );
  });

  it('rejects an invalid frequency or quantity with 422', async () => {
    await subscribe(fixture.alice, { frequencyDays: 7 }).expect(422);
    await subscribe(fixture.alice, { quantity: 11 }).expect(422);
  });

  it("rejects another customer's address with 403 and an inactive variant with 404", async () => {
    await subscribe(fixture.alice, { shippingAddressId: fixture.bob.addressId }).expect(403);
    await subscribe(fixture.alice, { productVariantId: fixture.inactiveVariantId }).expect(404);
  });

  it('moves through pause, resume, skip and cancel', async () => {
    const { id } = (await subscribe(fixture.alice).expect(201)).body;

    expect((await act(fixture.alice, id, 'pause').expect(200)).body.status).toBe('PAUSED');
    // Skipping is only allowed while ACTIVE
    await act(fixture.alice, id, 'skip-next').expect(400);

    // Resuming after the billing date has passed moves it to tomorrow
    await prisma.subscription.update({
      where: { id },
      data: { nextBillingDate: new Date(daysFromToday(-3)) },
    });
    const resumed = (await act(fixture.alice, id, 'resume').expect(200)).body;
    expect(resumed).toMatchObject({ status: 'ACTIVE', nextBillingDate: daysFromToday(1) });

    const skipped = (await act(fixture.alice, id, 'skip-next').expect(200)).body;
    expect(skipped.nextBillingDate).toBe(daysFromToday(31));

    const cancelled = (await act(fixture.alice, id, 'cancel').expect(200)).body;
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.cancelledAt).not.toBeNull();

    // CANCELLED is terminal
    await act(fixture.alice, id, 'resume').expect(400);
    await act(fixture.alice, id, 'pause').expect(400);
  });

  it("returns 403 when a customer changes someone else's subscription", async () => {
    const { id } = (await subscribe(fixture.alice).expect(201)).body;

    await act(fixture.bob, id, 'pause').expect(403);
    await act(fixture.bob, id, 'cancel').expect(403);
  });

  it('GET /api/subscriptions lists only the signed-in customer’s subscriptions', async () => {
    await subscribe(fixture.bob).expect(201);

    const alice = (await fixture.alice.agent.get('/api/subscriptions').expect(200)).body;
    const bob = (await fixture.bob.agent.get('/api/subscriptions').expect(200)).body;

    expect(alice.length).toBeGreaterThanOrEqual(3);
    expect(alice.every((s: { customerId: string }) => s.customerId === fixture.customers[0])).toBe(
      true,
    );
    expect(bob).toHaveLength(1);
  });

  it('requires a signed-in customer', async () => {
    await request(app.getHttpServer()).get('/api/subscriptions').expect(401);
  });
});
