import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdminRole, BatchStatus, OrderStatus, PaymentGateway, PaymentStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';

type Agent = ReturnType<typeof request.agent>;

interface Session {
  agent: Agent;
  csrf: string;
}

describe('Refund flow (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const stamp = `refund${Date.now()}`;
  const password = 'RefundTest2026';
  const fixture = {
    customerId: '',
    adminId: '',
    addressId: '',
    productId: '',
    variantId: '',
    freshBatchId: '',
    expiredBatchId: '',
    orderId: '',
    refundRequestId: '',
  };
  let customer: Session;
  let admin: Session;

  const signIn = async (email: string): Promise<Session> => {
    const agent = request.agent(app.getHttpServer());
    const csrf = (await agent.get('/api/auth/csrf').expect(200)).body.csrfToken as string;
    await agent
      .post('/api/auth/login')
      .set('x-csrf-token', csrf)
      .send({ email, password })
      .expect(200);
    return { agent, csrf };
  };

  const daysFromToday = (days: number): Date => {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    return new Date(today.getTime() + days * 86_400_000);
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    const passwordHash = await bcrypt.hash(password, 4);
    const customerRecord = await prisma.customer.create({
      data: {
        email: `${stamp}.customer@example.com`,
        passwordHash,
        name: 'Refund Customer',
      },
    });
    fixture.customerId = customerRecord.id;
    fixture.addressId = (
      await prisma.address.create({
        data: {
          customerId: fixture.customerId,
          line1: '12 Temple Road',
          city: 'Colombo',
          district: 'Colombo',
          postalCode: '00100',
        },
      })
    ).id;
    fixture.adminId = (
      await prisma.adminUser.create({
        data: {
          email: `${stamp}.admin@example.com`,
          passwordHash,
          name: 'Refund Admin',
          role: AdminRole.ADMIN,
        },
      })
    ).id;

    customer = await signIn(`${stamp}.customer@example.com`);
    admin = await signIn(`${stamp}.admin@example.com`);

    const product = await prisma.product.create({
      data: {
        slug: `${stamp}-product`,
        name: `${stamp} Product`,
        description: 'Refund e2e fixture',
        category: 'jams',
        basePrice: '500.00',
        unitWeightGrams: 300,
        variants: {
          create: {
            sku: `${stamp}-sku`,
            name: 'Refund 300g',
            size: '300 g',
            price: '500.00',
            unitWeightGrams: 300,
          },
        },
      },
      include: { variants: true },
    });
    fixture.productId = product.id;
    fixture.variantId = product.variants[0].id;

    const freshBatch = await prisma.productBatch.create({
      data: {
        productVariantId: fixture.variantId,
        batchNumber: `${stamp}-fresh`,
        manufacturedDate: daysFromToday(-30),
        expiryDate: daysFromToday(90),
        initialQuantity: 5,
        currentQuantity: 3,
        status: BatchStatus.ACTIVE,
      },
    });
    const expiredBatch = await prisma.productBatch.create({
      data: {
        productVariantId: fixture.variantId,
        batchNumber: `${stamp}-expired`,
        manufacturedDate: daysFromToday(-90),
        expiryDate: daysFromToday(-2),
        initialQuantity: 4,
        currentQuantity: 3,
        status: BatchStatus.EXPIRED,
      },
    });
    fixture.freshBatchId = freshBatch.id;
    fixture.expiredBatchId = expiredBatch.id;

    const order = await prisma.order.create({
      data: {
        customerId: fixture.customerId,
        shippingAddressId: fixture.addressId,
        status: OrderStatus.DELIVERED,
        paymentStatus: PaymentStatus.PAID,
        totalAmount: '1850.00',
        totalWeight: '900',
        shippingFee: '350.00',
        currency: 'LKR',
        deliveredAt: daysFromToday(-1),
        items: {
          create: [
            {
              productVariantId: fixture.variantId,
              batchId: fixture.freshBatchId,
              quantity: 2,
              unitPriceSnapshot: '500.00',
              lineTotal: '1000.00',
            },
            {
              productVariantId: fixture.variantId,
              batchId: fixture.expiredBatchId,
              quantity: 1,
              unitPriceSnapshot: '500.00',
              lineTotal: '500.00',
            },
          ],
        },
      },
    });
    fixture.orderId = order.id;

    await prisma.payment.create({
      data: {
        orderId: fixture.orderId,
        gateway: PaymentGateway.STRIPE,
        gatewayPaymentId: `pi_test_refund_${stamp}`,
        amount: '1850.00',
        currency: 'LKR',
        status: PaymentStatus.PAID,
        processedAt: daysFromToday(-2),
      },
    });
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.auditLog.deleteMany({
        where: { targetId: { in: [fixture.orderId, fixture.refundRequestId] } },
      });
      await prisma.refundRequest.deleteMany({ where: { orderId: fixture.orderId } });
      await prisma.payment.deleteMany({ where: { orderId: fixture.orderId } });
      await prisma.orderItem.deleteMany({ where: { orderId: fixture.orderId } });
      await prisma.order.deleteMany({ where: { id: fixture.orderId } });
      await prisma.productBatch.deleteMany({
        where: { id: { in: [fixture.freshBatchId, fixture.expiredBatchId] } },
      });
      await prisma.productVariant.deleteMany({ where: { id: fixture.variantId } });
      await prisma.product.deleteMany({ where: { id: fixture.productId } });
      await prisma.address.deleteMany({ where: { id: fixture.addressId } });
      await prisma.customer.deleteMany({ where: { id: fixture.customerId } });
      await prisma.adminUser.deleteMany({ where: { id: fixture.adminId } });
    }
    await app?.close();
  });

  it('refunds a delivered order and restocks only unexpired batches', async () => {
    const refundResponse = await customer.agent
      .post(`/api/orders/${fixture.orderId}/refund-requests`)
      .set('x-csrf-token', customer.csrf)
      .send({ reason: 'Two jars arrived broken in transit' })
      .expect(201);
    fixture.refundRequestId = refundResponse.body.id as string;
    expect(refundResponse.body.status).toBe('REQUESTED');
    expect(Number(refundResponse.body.amount)).toBe(1850);

    const approval = await admin.agent
      .post(`/api/admin/refund-requests/${refundResponse.body.id}/approve`)
      .set('x-csrf-token', admin.csrf)
      .expect(200);
    expect(approval.body.restocked).toEqual(
      expect.arrayContaining([
        { batchId: fixture.freshBatchId, quantity: 2, restocked: true },
        { batchId: fixture.expiredBatchId, quantity: 1, restocked: false },
      ]),
    );

    await expect(
      prisma.order.findUniqueOrThrow({ where: { id: fixture.orderId } }),
    ).resolves.toMatchObject({ status: OrderStatus.REFUNDED });
    await expect(
      prisma.payment.findFirstOrThrow({ where: { orderId: fixture.orderId } }),
    ).resolves.toMatchObject({ status: PaymentStatus.REFUNDED });
    await expect(
      prisma.productBatch.findUniqueOrThrow({ where: { id: fixture.freshBatchId } }),
    ).resolves.toMatchObject({ currentQuantity: 5 });
    await expect(
      prisma.productBatch.findUniqueOrThrow({ where: { id: fixture.expiredBatchId } }),
    ).resolves.toMatchObject({ currentQuantity: 3, status: BatchStatus.EXPIRED });

    await customer.agent
      .post(`/api/orders/${fixture.orderId}/refund-requests`)
      .set('x-csrf-token', customer.csrf)
      .send({ reason: 'Please refund this order again' })
      .expect(400);
  });
});
