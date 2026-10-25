import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdminRole, DeliveryAssignmentStatus, OrderStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';

type Agent = ReturnType<typeof request.agent>;

interface Session {
  agent: Agent;
  csrf: string;
}

describe('Delivery assignment flow (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const stamp = `delivery${Date.now()}`;
  const password = 'DeliveryTest2026';
  const originalJwtSecret = process.env.JWT_SECRET;
  const originalTokenEncryptionKey = process.env.SUBSCRIPTION_TOKEN_ENC_KEY;
  const ids = {
    admin: '',
    customer: '',
    address: '',
    activeRider: '',
    otherRider: '',
    inactiveRider: '',
    shippedOrder: '',
    secondShippedOrder: '',
    paidOrder: '',
  };
  let admin: Session;
  let rider: Session;
  let otherRider: Session;

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

  const createOrder = (status: OrderStatus) =>
    prisma.order.create({
      data: {
        customerId: ids.customer,
        shippingAddressId: ids.address,
        status,
        totalAmount: '1000.00',
        totalWeight: '500',
        shippingFee: '0.00',
      },
    });

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'delivery-e2e-test-secret-at-least-32-characters';
    process.env.SUBSCRIPTION_TOKEN_ENC_KEY ??= 'delivery-e2e-token-encryption-key';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RedisService)
      .useValue({ isJtiRevoked: jest.fn().mockResolvedValue(false) })
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    const passwordHash = await bcrypt.hash(password, 4);
    ids.admin = (
      await prisma.adminUser.create({
        data: {
          email: `${stamp}.admin@example.com`,
          passwordHash,
          name: 'Delivery Admin',
          role: AdminRole.ADMIN,
        },
      })
    ).id;
    ids.customer = (
      await prisma.customer.create({
        data: {
          email: `${stamp}.customer@example.com`,
          passwordHash,
          name: 'Delivery Customer',
        },
      })
    ).id;
    ids.address = (
      await prisma.address.create({
        data: {
          customerId: ids.customer,
          line1: '12 Temple Road',
          city: 'Colombo',
          district: 'Colombo',
          postalCode: '00100',
        },
      })
    ).id;

    const activeRider = await prisma.deliveryUser.create({
      data: {
        email: `${stamp}.rider@example.com`,
        passwordHash,
        name: 'Active Rider',
        phone: '0771234567',
      },
    });
    ids.activeRider = activeRider.id;
    const secondRider = await prisma.deliveryUser.create({
      data: {
        email: `${stamp}.other@example.com`,
        passwordHash,
        name: 'Other Rider',
        phone: '0771234568',
      },
    });
    ids.otherRider = secondRider.id;
    ids.inactiveRider = (
      await prisma.deliveryUser.create({
        data: {
          email: `${stamp}.inactive@example.com`,
          passwordHash,
          name: 'Inactive Rider',
          phone: '0771234569',
          active: false,
        },
      })
    ).id;

    ids.shippedOrder = (await createOrder(OrderStatus.SHIPPED)).id;
    ids.secondShippedOrder = (await createOrder(OrderStatus.SHIPPED)).id;
    ids.paidOrder = (await createOrder(OrderStatus.PAID)).id;
    admin = await signIn(`${stamp}.admin@example.com`);
    rider = await signIn(`${stamp}.rider@example.com`);
    otherRider = await signIn(`${stamp}.other@example.com`);
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.deliveryAssignment.deleteMany({
        where: { orderId: { in: [ids.shippedOrder, ids.secondShippedOrder].filter(Boolean) } },
      });
      await prisma.order.deleteMany({
        where: {
          id: { in: [ids.shippedOrder, ids.secondShippedOrder, ids.paidOrder].filter(Boolean) },
        },
      });
      if (ids.address) await prisma.address.deleteMany({ where: { id: ids.address } });
      await prisma.deliveryUser.deleteMany({
        where: { id: { in: [ids.activeRider, ids.otherRider, ids.inactiveRider].filter(Boolean) } },
      });
      if (ids.customer) await prisma.customer.deleteMany({ where: { id: ids.customer } });
      if (ids.admin) {
        await prisma.auditLog.deleteMany({ where: { actorId: ids.admin } });
        await prisma.adminUser.deleteMany({ where: { id: ids.admin } });
      }
    }
    await app?.close();
    if (originalJwtSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalJwtSecret;
    }
    if (originalTokenEncryptionKey === undefined) {
      delete process.env.SUBSCRIPTION_TOKEN_ENC_KEY;
    } else {
      process.env.SUBSCRIPTION_TOKEN_ENC_KEY = originalTokenEncryptionKey;
    }
  });

  it('assigns shipped orders and completes a proof-backed rider delivery', async () => {
    const assigned = await admin.agent
      .post('/api/admin/delivery/assignments')
      .set('x-csrf-token', admin.csrf)
      .send({ orderId: ids.shippedOrder, deliveryUserId: ids.activeRider })
      .expect(201);
    const assignmentId = assigned.body.id as string;

    await admin.agent
      .post('/api/admin/delivery/assignments')
      .set('x-csrf-token', admin.csrf)
      .send({ orderId: ids.shippedOrder, deliveryUserId: ids.otherRider })
      .expect(409);
    await admin.agent
      .post('/api/admin/delivery/assignments')
      .set('x-csrf-token', admin.csrf)
      .send({ orderId: ids.paidOrder, deliveryUserId: ids.activeRider })
      .expect(400);
    await admin.agent
      .post('/api/admin/delivery/assignments')
      .set('x-csrf-token', admin.csrf)
      .send({ orderId: ids.secondShippedOrder, deliveryUserId: ids.inactiveRider })
      .expect(404);

    const assignments = await rider.agent.get('/api/delivery/assignments').expect(200);
    expect(assignments.body).toHaveLength(1);
    await otherRider.agent
      .post(`/api/delivery/assignments/${assignmentId}/status`)
      .set('x-csrf-token', otherRider.csrf)
      .send({ status: DeliveryAssignmentStatus.PICKED_UP })
      .expect(403);
    await rider.agent
      .post(`/api/delivery/assignments/${assignmentId}/status`)
      .set('x-csrf-token', rider.csrf)
      .send({ status: DeliveryAssignmentStatus.OUT_FOR_DELIVERY })
      .expect(400);

    await rider.agent
      .post(`/api/delivery/assignments/${assignmentId}/status`)
      .set('x-csrf-token', rider.csrf)
      .send({ status: DeliveryAssignmentStatus.PICKED_UP })
      .expect(200);
    await rider.agent
      .post(`/api/delivery/assignments/${assignmentId}/status`)
      .set('x-csrf-token', rider.csrf)
      .send({ status: DeliveryAssignmentStatus.OUT_FOR_DELIVERY })
      .expect(200);
    await rider.agent
      .post(`/api/delivery/assignments/${assignmentId}/status`)
      .set('x-csrf-token', rider.csrf)
      .send({
        status: DeliveryAssignmentStatus.DELIVERED,
        latitude: 91,
        longitude: 79.8,
      })
      .expect(422);
    await rider.agent
      .post(`/api/delivery/assignments/${assignmentId}/status`)
      .set('x-csrf-token', rider.csrf)
      .send({
        status: DeliveryAssignmentStatus.DELIVERED,
        latitude: 6.9,
        longitude: 79.8,
      })
      .expect(400);

    await rider.agent
      .post(`/api/delivery/assignments/${assignmentId}/proof`)
      .set('x-csrf-token', rider.csrf)
      .send({ proofPhotoUrl: 'https://proof.example/delivery.jpg' })
      .expect(200);
    await rider.agent
      .post(`/api/delivery/assignments/${assignmentId}/status`)
      .set('x-csrf-token', rider.csrf)
      .send({
        status: DeliveryAssignmentStatus.DELIVERED,
        latitude: 6.9,
        longitude: 79.8,
      })
      .expect(200);
    await rider.agent
      .post(`/api/delivery/assignments/${assignmentId}/proof`)
      .set('x-csrf-token', rider.csrf)
      .send({ proofPhotoUrl: 'https://proof.example/late.jpg' })
      .expect(400);

    await expect(
      prisma.order.findUniqueOrThrow({ where: { id: ids.shippedOrder } }),
    ).resolves.toMatchObject({ status: OrderStatus.DELIVERED });
    await expect(
      prisma.deliveryAssignment.findUniqueOrThrow({ where: { id: assignmentId } }),
    ).resolves.toMatchObject({
      status: DeliveryAssignmentStatus.DELIVERED,
      proofPhotoUrl: 'https://proof.example/delivery.jpg',
    });
    const auditEntries = await prisma.auditLog.findMany({
      where: { targetId: { in: [assignmentId, ids.shippedOrder] } },
    });
    expect(auditEntries.map((entry) => entry.action)).toEqual(
      expect.arrayContaining(['delivery.assign', 'delivery.status.picked_up', 'order.delivered']),
    );
  });

  it('makes failed assignments terminal and rejects proof or reassignment', async () => {
    const assignment = await admin.agent
      .post('/api/admin/delivery/assignments')
      .set('x-csrf-token', admin.csrf)
      .send({ orderId: ids.secondShippedOrder, deliveryUserId: ids.otherRider })
      .expect(201);
    const assignmentId = assignment.body.id as string;

    await otherRider.agent
      .post(`/api/delivery/assignments/${assignmentId}/status`)
      .set('x-csrf-token', otherRider.csrf)
      .send({ status: DeliveryAssignmentStatus.PICKED_UP })
      .expect(200);
    await otherRider.agent
      .post(`/api/delivery/assignments/${assignmentId}/status`)
      .set('x-csrf-token', otherRider.csrf)
      .send({ status: DeliveryAssignmentStatus.OUT_FOR_DELIVERY })
      .expect(200);
    await otherRider.agent
      .post(`/api/delivery/assignments/${assignmentId}/status`)
      .set('x-csrf-token', otherRider.csrf)
      .send({ status: DeliveryAssignmentStatus.FAILED, failureReason: 'Customer unavailable' })
      .expect(200);
    await otherRider.agent
      .post(`/api/delivery/assignments/${assignmentId}/proof`)
      .set('x-csrf-token', otherRider.csrf)
      .send({ proofPhotoUrl: 'https://proof.example/late.jpg' })
      .expect(400);
    await admin.agent
      .post('/api/admin/delivery/assignments')
      .set('x-csrf-token', admin.csrf)
      .send({ orderId: ids.secondShippedOrder, deliveryUserId: ids.activeRider })
      .expect(409);
  });

  it('registers the authenticated rider FCM token', async () => {
    await rider.agent
      .put('/api/delivery/fcm-token')
      .set('x-csrf-token', rider.csrf)
      .send({ token: 'test-fcm-token' })
      .expect(200);
    await expect(
      prisma.deliveryUser.findUniqueOrThrow({ where: { id: ids.activeRider } }),
    ).resolves.toMatchObject({ fcmToken: 'test-fcm-token' });
  });
});
