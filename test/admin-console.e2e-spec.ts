import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  AdminRole,
  BatchStatus,
  OrderStatus,
  PaymentGateway,
  PaymentStatus,
  SellerStatus,
  SubscriptionStatus,
} from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { fixtureEmail, fixtureNamespace } from './helpers/fixtures';

type Agent = ReturnType<typeof request.agent>;

interface Session {
  agent: Agent;
  csrf: string;
}

// Exercises the console routes with the same payloads the admin pages send.
describe('Admin console API (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: Session;
  let staff: Session;
  let customer: Session;
  const namespace = fixtureNamespace('console');
  const email = (name: string) => fixtureEmail(namespace, name);
  const password = 'ConsoleTest2026';
  const ids = {
    admin: '',
    customer: '',
    address: '',
    seller: '',
    product: '',
    variant: '',
    batch: '',
    rider: '',
  };

  const signIn = async (address: string): Promise<Session> => {
    const agent = request.agent(app.getHttpServer());
    const csrf = (await agent.get('/api/auth/csrf').expect(200)).body.csrfToken as string;
    await agent
      .post('/api/auth/login')
      .set('x-csrf-token', csrf)
      .send({ email: address, password })
      .expect(200);
    return { agent, csrf };
  };

  const post = (session: Session, path: string, body: object = {}) =>
    session.agent.post(path).set('x-csrf-token', session.csrf).send(body);
  const patch = (session: Session, path: string, body: object = {}) =>
    session.agent.patch(path).set('x-csrf-token', session.csrf).send(body);
  const del = (session: Session, path: string) =>
    session.agent.delete(path).set('x-csrf-token', session.csrf);

  const createOrder = async (status: OrderStatus, quantity = 2) => {
    const order = await prisma.order.create({
      data: {
        customerId: ids.customer,
        shippingAddressId: ids.address,
        status,
        paymentStatus:
          status === OrderStatus.PENDING_PAYMENT ? PaymentStatus.PENDING : PaymentStatus.PAID,
        totalAmount: '1000.00',
        totalWeight: '500',
        shippingFee: '200.00',
        items: {
          create: {
            productVariantId: ids.variant,
            batchId: ids.batch,
            quantity,
            unitPriceSnapshot: '400.00',
            lineTotal: '800.00',
          },
        },
      },
    });
    await prisma.payment.create({
      data: {
        orderId: order.id,
        gateway: PaymentGateway.STRIPE,
        gatewayPaymentId: `pi_${order.id}`,
        amount: '1000.00',
        status: status === OrderStatus.PENDING_PAYMENT ? PaymentStatus.PENDING : PaymentStatus.PAID,
      },
    });
    return order;
  };

  const batchQuantity = async () =>
    (await prisma.productBatch.findUniqueOrThrow({ where: { id: ids.batch } })).currentQuantity;

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'console-e2e-test-secret-at-least-32-characters';
    process.env.SUBSCRIPTION_TOKEN_ENC_KEY ??= 'console-e2e-token-encryption-key';
    process.env.STRIPE_WEBHOOK_SECRET ??= 'whsec_console_e2e';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    const passwordHash = await bcrypt.hash(password, 4);
    ids.admin = (
      await prisma.adminUser.create({
        data: { email: email('admin'), passwordHash, name: 'Console Admin', role: AdminRole.ADMIN },
      })
    ).id;
    await prisma.adminUser.create({
      data: {
        email: email('staff'),
        passwordHash,
        name: 'Console Staff',
        role: AdminRole.FULFILMENT_STAFF,
      },
    });
    ids.customer = (
      await prisma.customer.create({
        data: { email: email('customer'), passwordHash, name: 'Console Customer' },
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
    ids.seller = (
      await prisma.seller.create({
        data: {
          email: email('seller'),
          passwordHash,
          businessName: `Console Foods ${namespace}`,
          contactName: 'Console Seller',
          phone: '0771234567',
          status: SellerStatus.APPROVED,
          approvedAt: new Date(),
        },
      })
    ).id;
    const product = await prisma.product.create({
      data: {
        sellerId: ids.seller,
        name: `Console Jam ${namespace}`,
        slug: `console-jam-${namespace}`,
        description: 'Small batch jam',
        category: 'jam',
        basePrice: '400.00',
        unitWeightGrams: 250,
        variants: {
          create: {
            sku: `CONSOLE-${namespace}`,
            name: 'Console Jam 250g',
            size: '250g',
            price: '400.00',
            unitWeightGrams: 250,
          },
        },
      },
      include: { variants: true },
    });
    ids.product = product.id;
    ids.variant = product.variants[0].id;
    ids.batch = (
      await prisma.productBatch.create({
        data: {
          productVariantId: ids.variant,
          batchNumber: `B-${namespace}`,
          initialQuantity: 100,
          currentQuantity: 50,
          manufacturedDate: new Date('2026-01-01'),
          expiryDate: new Date('2030-01-01'),
          status: BatchStatus.ACTIVE,
        },
      })
    ).id;

    admin = await signIn(email('admin'));
    staff = await signIn(email('staff'));
    customer = await signIn(email('customer'));
  });

  afterAll(async () => {
    await app.close();
  });

  describe('orders', () => {
    it('lists every order with the fields the orders table reads', async () => {
      const order = await createOrder(OrderStatus.PAID);
      const res = await admin.agent
        .get(`/api/admin/orders?search=${encodeURIComponent(email('customer'))}&pageSize=25`)
        .expect(200);

      expect(res.body).toMatchObject({ page: 1, pageSize: 25 });
      expect(res.body.items[0]).toMatchObject({
        id: order.id,
        orderNumber: order.orderNumber,
        status: 'PAID',
        paymentStatus: 'PAID',
        totalAmount: '1000.00',
        itemCount: 1,
        deliveryStatus: null,
        customer: { email: email('customer') },
      });

      const byNumber = await staff.agent
        .get(`/api/admin/orders?search=BB-${String(order.orderNumber).padStart(6, '0')}`)
        .expect(200);
      expect(byNumber.body.items.map((row: { id: string }) => row.id)).toEqual([order.id]);
    });

    it('returns the order detail page', async () => {
      const order = await createOrder(OrderStatus.PAID);
      const res = await staff.agent.get(`/api/admin/orders/${order.id}`).expect(200);

      expect(res.body).toMatchObject({
        orderNumber: order.orderNumber,
        subtotal: '800.00',
        discountAmount: '0.00',
        promoCode: null,
        shippingFee: '200.00',
        totalWeightG: 500,
        customer: { name: 'Console Customer' },
        shippingAddress: { city: 'Colombo' },
        delivery: null,
      });
      expect(res.body.items[0]).toMatchObject({
        sku: `CONSOLE-${namespace}`,
        size: '250g',
        lineTotal: '800.00',
      });
      expect(res.body.payments[0]).toMatchObject({ amount: '1000.00', refundedAmount: '0.00' });
    });

    it('answers 404 for an unknown order', async () => {
      await admin.agent.get('/api/admin/orders/00000000-0000-4000-8000-000000000000').expect(404);
    });

    it('refunds and restocks a paid order cancelled by an admin', async () => {
      const order = await createOrder(OrderStatus.PAID);
      const before = await batchQuantity();

      const res = await post(admin, `/api/admin/orders/${order.id}/cancel`, {
        reason: 'Customer called to cancel',
      }).expect(200);

      expect(res.body).toMatchObject({
        status: 'CANCELLED',
        paymentStatus: 'REFUNDED',
        cancellationReason: 'Customer called to cancel',
      });
      expect(res.body.payments[0]).toMatchObject({
        status: 'REFUNDED',
        refundedAmount: '1000.00',
      });
      expect(await batchQuantity()).toBe(before + 2);
      await post(admin, `/api/admin/orders/${order.id}/cancel`, { reason: 'Again' }).expect(400);
    });

    it('keeps cancellation to admins', async () => {
      const order = await createOrder(OrderStatus.PAID);
      await post(staff, `/api/admin/orders/${order.id}/cancel`, { reason: 'Not allowed' }).expect(
        403,
      );
    });

    it('lets a customer cancel their own unpaid order', async () => {
      const order = await createOrder(OrderStatus.PENDING_PAYMENT);
      const before = await batchQuantity();

      const res = await post(customer, `/api/orders/${order.id}/cancel`).expect(200);

      expect(res.body.status).toBe('CANCELLED');
      expect(await batchQuantity()).toBe(before + 2);
      const paid = await createOrder(OrderStatus.PAID);
      await post(customer, `/api/orders/${paid.id}/cancel`).expect(400);
    });

    it('refuses customers on the staff routes', async () => {
      await customer.agent.get('/api/admin/orders').expect(403);
    });
  });

  describe('riders and deliveries', () => {
    it('creates a rider, lists them and assigns a shipped order', async () => {
      const created = await post(admin, '/api/admin/riders', {
        email: email('rider'),
        password,
        name: 'Console Rider',
        phone: '0771112222',
      }).expect(201);
      ids.rider = created.body.id as string;
      expect(created.body).toMatchObject({ pushEnabled: false, openAssignments: 0 });

      const order = await createOrder(OrderStatus.SHIPPED);
      await post(staff, `/api/admin/orders/${order.id}/assign`, {
        deliveryUserId: ids.rider,
      }).expect(201);

      const riders = await staff.agent.get('/api/admin/riders').expect(200);
      const rider = riders.body.find((row: { id: string }) => row.id === ids.rider);
      expect(rider.openAssignments).toBe(1);

      const assignments = await staff.agent
        .get('/api/admin/delivery-assignments?status=ASSIGNED')
        .expect(200);
      const assignment = assignments.body.find(
        (row: { orderId: string }) => row.orderId === order.id,
      );
      expect(assignment).toMatchObject({
        deliveryUser: { name: 'Console Rider' },
        order: { orderNumber: order.orderNumber },
      });

      const detail = await admin.agent.get(`/api/admin/orders/${order.id}`).expect(200);
      expect(detail.body.delivery).toMatchObject({
        status: 'ASSIGNED',
        riderName: 'Console Rider',
      });
    });

    it('deactivates a rider and rejects a duplicate email', async () => {
      const res = await patch(admin, `/api/admin/riders/${ids.rider}`, { active: false }).expect(
        200,
      );
      expect(res.body.active).toBe(false);
      await post(admin, '/api/admin/riders', {
        email: email('rider'),
        password,
        name: 'Duplicate',
        phone: '0771112222',
      }).expect(409);
      await post(staff, '/api/admin/riders', {
        email: email('other-rider'),
        password,
        name: 'Refused',
        phone: '0771112222',
      }).expect(403);
    });
  });

  describe('staff accounts', () => {
    it('creates and updates a staff account without locking the console', async () => {
      const created = await post(admin, '/api/admin/staff', {
        email: email('packer'),
        password,
        name: 'Console Packer',
        role: 'FULFILMENT_STAFF',
      }).expect(201);
      expect(created.body.passwordHash).toBeUndefined();

      const list = await admin.agent.get('/api/admin/staff').expect(200);
      expect(list.body.map((row: { id: string }) => row.id)).toContain(created.body.id);

      const res = await patch(admin, `/api/admin/staff/${created.body.id}`, {
        active: false,
      }).expect(200);
      expect(res.body.active).toBe(false);
      await patch(admin, `/api/admin/staff/${ids.admin}`, { active: false }).expect(400);
      await staff.agent.get('/api/admin/staff').expect(403);
    });
  });

  describe('shipping rates', () => {
    it('lists the brackets and refuses a gap', async () => {
      const list = await admin.agent.get('/api/admin/shipping-rates').expect(200);
      expect(Array.isArray(list.body)).toBe(true);

      await post(admin, '/api/admin/shipping-rates', {
        minWeightG: 90_000_000,
        maxWeightG: 90_000_100,
        feeLkr: '100.00',
        label: 'Gap',
      }).expect(422);
    });
  });

  describe('promo codes', () => {
    const code = `C${namespace.slice(-20)}`.toLowerCase();

    it('creates, lists and toggles a code', async () => {
      const created = await post(admin, '/api/admin/promo-codes', {
        code,
        discountType: 'PERCENTAGE',
        discountValue: '10',
        validFrom: '2026-01-01T00:00:00.000Z',
        validUntil: '2030-01-01T00:00:00.000Z',
      }).expect(201);
      expect(created.body.code).toBe(code.toUpperCase());

      const list = await admin.agent.get('/api/admin/promo-codes').expect(200);
      expect(list.body.map((row: { id: string }) => row.id)).toContain(created.body.id);

      const toggled = await patch(admin, `/api/admin/promo-codes/${created.body.id}`, {
        active: false,
      }).expect(200);
      expect(toggled.body.active).toBe(false);
    });

    it('rejects a duplicate and a percentage above 100', async () => {
      const body = {
        code,
        discountType: 'PERCENTAGE',
        discountValue: '10',
        validFrom: '2026-01-01T00:00:00.000Z',
        validUntil: '2030-01-01T00:00:00.000Z',
      };
      await post(admin, '/api/admin/promo-codes', body).expect(409);
      await post(admin, '/api/admin/promo-codes', {
        ...body,
        code: `${code}x`,
        discountValue: '150',
      }).expect(422);
    });
  });

  describe('products', () => {
    it('lists products with stock and finds them by SKU', async () => {
      const res = await admin.agent
        .get(`/api/admin/products?search=CONSOLE-${namespace}&page=1&pageSize=20`)
        .expect(200);

      expect(res.body.total).toBe(1);
      expect(res.body.items[0]).toMatchObject({
        id: ids.product,
        basePrice: '400.00',
        unitWeightG: 250,
        images: [],
        seller: { id: ids.seller },
      });
      expect(res.body.items[0].variants[0]).toMatchObject({
        price: '400.00',
        unitWeightG: 250,
      });
      expect(res.body.items[0].variants[0].available).toBeGreaterThan(0);
    });

    it('creates a product from the editor payload and generates the slug', async () => {
      const res = await post(admin, '/api/admin/products', {
        name: 'Console Relish',
        description: 'Tomato relish',
        category: 'relish',
        basePrice: '650.00',
        unitWeightG: 300,
        ingredients: 'Tomato, chilli',
        allergens: null,
        sellerId: ids.seller,
        variants: [
          {
            sku: `RELISH-${namespace}`,
            name: 'Relish 300g',
            size: '300g',
            price: '650.00',
            unitWeightG: 300,
          },
        ],
      }).expect(201);

      expect(res.body.slug).toMatch(/^console-relish/);
      expect(res.body).toMatchObject({
        unitWeightG: 300,
        ingredients: 'Tomato, chilli',
        seller: { id: ids.seller },
      });
    });

    it('updates a product and variant from the editor and restores them', async () => {
      const updated = await patch(admin, `/api/admin/products/${ids.product}`, {
        name: `Console Jam ${namespace}`,
        description: 'Small batch jam',
        category: 'jam',
        basePrice: '420.00',
        unitWeightG: 260,
        ingredients: 'Strawberry',
        allergens: null,
      }).expect(200);
      expect(updated.body).toMatchObject({ basePrice: '420.00', unitWeightG: 260 });

      await del(admin, `/api/admin/products/${ids.product}`).expect(200);
      const restored = await patch(admin, `/api/admin/products/${ids.product}`, {
        active: true,
      }).expect(200);
      expect(restored.body.active).toBe(true);

      const variant = await patch(
        admin,
        `/api/admin/products/${ids.product}/variants/${ids.variant}`,
        { active: true, unitWeightG: 250 },
      ).expect(200);
      expect(variant.body.unitWeightGrams).toBe(250);
    });

    it('explains that image uploads need a bucket', async () => {
      const res = await post(admin, '/api/uploads/product-image', {
        productId: ids.product,
        contentType: 'image/png',
        sizeBytes: 1024,
      });
      expect(process.env.UPLOADS_BUCKET ? 200 : 503).toBe(res.status);
    });

    it('shows gallery images in the public catalogue', async () => {
      const image = await prisma.productImage.create({
        data: { productId: ids.product, url: 'https://cdn.example.com/jam.jpg', altText: 'Jam' },
      });
      const slug = `console-jam-${namespace}`;
      const res = await request(app.getHttpServer()).get(`/api/products/${slug}`).expect(200);
      expect(res.body.images).toEqual([
        { id: image.id, url: 'https://cdn.example.com/jam.jpg', altText: 'Jam' },
      ]);

      await del(admin, `/api/admin/products/${ids.product}/images/${image.id}`).expect(200);
      const after = await admin.agent.get(`/api/admin/products/${ids.product}`).expect(200);
      expect(after.body.images).toEqual([]);
    });
  });

  describe('bundles', () => {
    let bundleId = '';
    let slug = '';

    it('creates a gift box and shows it in the shop', async () => {
      const res = await post(admin, '/api/admin/bundles', {
        name: `Console Box ${namespace}`,
        description: 'A box of jam',
        price: '700.00',
        sellerId: ids.seller,
        items: [{ productVariantId: ids.variant, quantity: 2 }],
      }).expect(201);
      bundleId = res.body.id as string;
      slug = res.body.slug as string;
      expect(res.body).toMatchObject({
        componentsTotal: '800.00',
        totalWeightG: 500,
        seller: { id: ids.seller },
      });
      expect(res.body.available).toBeGreaterThan(0);

      const list = await request(app.getHttpServer()).get('/api/bundles').expect(200);
      expect(list.body.items.map((row: { id: string }) => row.id)).toContain(bundleId);
      await request(app.getHttpServer()).get(`/api/bundles/${slug}`).expect(200);
    });

    it('lists inactive boxes for admins and hides them from the shop', async () => {
      await del(admin, `/api/admin/bundles/${bundleId}`).expect(200);

      const list = await admin.agent
        .get('/api/admin/bundles?includeInactive=true&pageSize=60')
        .expect(200);
      const box = list.body.items.find((row: { id: string }) => row.id === bundleId);
      expect(box.active).toBe(false);
      await request(app.getHttpServer()).get(`/api/bundles/${slug}`).expect(404);
    });
  });

  describe('sellers', () => {
    it('filters by status and suspends a seller out of the shop', async () => {
      const list = await admin.agent.get('/api/admin/sellers?status=APPROVED').expect(200);
      const row = list.body.find((seller: { id: string }) => seller.id === ids.seller);
      expect(row._count.products).toBeGreaterThan(0);

      const res = await post(admin, `/api/admin/sellers/${ids.seller}/suspend`, {
        reason: 'Failed a food safety audit',
      }).expect(200);
      expect(res.body.status).toBe('SUSPENDED');
      const slug = `console-jam-${namespace}`;
      await request(app.getHttpServer()).get(`/api/products/${slug}`).expect(404);

      await post(admin, `/api/admin/sellers/${ids.seller}/reinstate`).expect(200);
      await request(app.getHttpServer()).get(`/api/products/${slug}`).expect(200);
      await post(admin, `/api/admin/sellers/${ids.seller}/reinstate`).expect(400);
    });
  });

  describe('subscriptions', () => {
    it('lists subscriptions and pauses, resumes and cancels them', async () => {
      const sub = await prisma.subscription.create({
        data: {
          customerId: ids.customer,
          productVariantId: ids.variant,
          shippingAddressId: ids.address,
          frequencyDays: 30,
          discountRate: '0.1000',
          status: SubscriptionStatus.ACTIVE,
          nextBillingDate: new Date('2030-01-01'),
          paymentTokenEncrypted: Buffer.from('token'),
          paymentGateway: PaymentGateway.STRIPE,
        },
      });

      const list = await admin.agent
        .get('/api/admin/subscriptions?status=ACTIVE&page=1&pageSize=25')
        .expect(200);
      const row = list.body.items.find((item: { id: string }) => item.id === sub.id);
      expect(row).toMatchObject({
        discountedUnitPrice: '360.00',
        customer: { email: email('customer') },
        variant: { size: '250g' },
      });
      expect(row.paymentTokenEncrypted).toBeUndefined();

      const paused = await patch(admin, `/api/admin/subscriptions/${sub.id}/pause`).expect(200);
      expect(paused.body.status).toBe('PAUSED');
      await patch(admin, `/api/admin/subscriptions/${sub.id}/resume`).expect(200);
      const cancelled = await patch(admin, `/api/admin/subscriptions/${sub.id}/cancel`).expect(200);
      expect(cancelled.body.status).toBe('CANCELLED');
      await patch(
        admin,
        '/api/admin/subscriptions/00000000-0000-4000-8000-000000000000/pause',
      ).expect(404);
    });
  });

  describe('reviews and support', () => {
    it('takes a review from submission through moderation', async () => {
      await createOrder(OrderStatus.DELIVERED);
      const created = await post(customer, '/api/reviews', {
        productId: ids.product,
        rating: 5,
        comment: 'Lovely jam',
      }).expect(201);

      const pending = await admin.agent.get('/api/admin/reviews?approved=false').expect(200);
      const row = pending.body.find((review: { id: string }) => review.id === created.body.id);
      expect(row).toMatchObject({ approved: false, customer: { name: 'Console Customer' } });

      await post(admin, `/api/admin/reviews/${created.body.id}/approve`).expect(200);
      const approved = await admin.agent.get('/api/admin/reviews?approved=true').expect(200);
      expect(approved.body.map((review: { id: string }) => review.id)).toContain(created.body.id);

      await post(admin, `/api/admin/reviews/${created.body.id}/reject`).expect(200);
      await post(admin, `/api/admin/reviews/${created.body.id}/reject`).expect(404);
    });

    it('resolves and closes a support ticket', async () => {
      const ticket = await prisma.supportTicket.create({
        data: { customerId: ids.customer, subject: 'Late order', message: 'Where is it?' },
      });
      const resolved = await post(admin, `/api/admin/support/tickets/${ticket.id}/resolve`).expect(
        200,
      );
      expect(resolved.body.status).toBe('RESOLVED');
      const closed = await post(admin, `/api/admin/support/tickets/${ticket.id}/close`).expect(200);
      expect(closed.body.status).toBe('CLOSED');
    });
  });
});
