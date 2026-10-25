import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { fixtureEmail, fixtureNamespace } from './helpers/fixtures';

describe('Shipping quote boundaries (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const stamp = fixtureNamespace('shipping-quote');
  const password = 'ShippingQuote2026';
  let customerAgent: ReturnType<typeof request.agent>;
  let csrfToken = '';
  let customerId = '';
  let productId = '';
  let batchId = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    customerAgent = request.agent(app.getHttpServer());
    csrfToken = (await customerAgent.get('/api/auth/csrf').expect(200)).body.csrfToken as string;
    const email = fixtureEmail(stamp, 'customer');
    const registration = await customerAgent
      .post('/api/auth/register')
      .set('x-csrf-token', csrfToken)
      .send({ email, password, name: 'Shipping Quote Customer' })
      .expect(201);
    customerId = registration.body.id as string;
    await customerAgent
      .post('/api/auth/login')
      .set('x-csrf-token', csrfToken)
      .send({ email, password })
      .expect(200);

    const product = await prisma.product.create({
      data: {
        slug: `${stamp}-product`,
        name: `${stamp} Product`,
        description: 'Shipping quote boundary fixture',
        category: 'honey',
        basePrice: '1500.00',
        unitWeightGrams: 500,
        variants: {
          create: {
            sku: `${stamp}-500g`,
            name: '500g',
            size: '500 g',
            price: '1500.00',
            unitWeightGrams: 500,
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
        initialQuantity: 1,
        currentQuantity: 1,
      },
    });
    batchId = batch.id;
    await customerAgent
      .post('/api/cart/items')
      .set('x-csrf-token', csrfToken)
      .send({ productVariantId: product.variants[0].id, quantity: 1 })
      .expect(200);
  });

  afterAll(async () => {
    if (prisma) {
      if (customerId) await prisma.cartItem.deleteMany({ where: { customerId } });
      if (batchId) await prisma.productBatch.deleteMany({ where: { id: batchId } });
      if (productId) await prisma.product.deleteMany({ where: { id: productId } });
      if (customerId) await prisma.customer.deleteMany({ where: { id: customerId } });
    }
    await app?.close();
  });

  it('uses the 0–500 g rate at its inclusive upper boundary', async () => {
    await expect(customerAgent.get('/api/checkout/quote').expect(200)).resolves.toMatchObject({
      body: {
        totalWeightG: 500,
        shippingFee: '350.00',
        shippingBracket: '0–500 g',
      },
    });
  });
});
