import { INestApplication } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../src/app.module';
import { ExpiryCronService } from '../src/batches/expiry-cron.service';
import { InventoryService } from '../src/inventory/inventory.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { SubscriptionsService } from '../src/subscriptions/subscriptions.service';

/**
 * Domain events against Postgres, with the resulting emails checked in MailHog
 * through its HTTP API (port 8025 in docker-compose.yml and CI).
 */
const MAILHOG = process.env.MAILHOG_BASE_URL ?? 'http://localhost:8025';
const TEMPLATE_ID = 'd-batch-expiring-soon';

interface MailHogItem {
  Content: { Headers: Record<string, string[]> };
}

interface Mail {
  to: string;
  subject: string;
  template: string;
}

// MailHog returns non-ASCII subjects as RFC 2047 encoded words (=?UTF-8?Q?...?=)
function decodeHeader(value: string): string {
  return value
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?UTF-8\?([QB])\?([^?]*)\?=/gi, (_match, encoding: string, text: string) =>
      encoding.toUpperCase() === 'B'
        ? Buffer.from(text, 'base64').toString('utf8')
        : Buffer.from(
            text
              .replace(/_/g, ' ')
              .replace(/=([0-9A-F]{2})/gi, (_hex, code: string) =>
                String.fromCharCode(parseInt(code, 16)),
              ),
            'latin1',
          ).toString('utf8'),
    );
}

async function allMails(): Promise<Mail[]> {
  const res = await fetch(`${MAILHOG}/api/v2/messages?limit=500`);
  const json = (await res.json()) as { items: MailHogItem[] };
  return json.items.map((m) => ({
    to: m.Content.Headers.To?.[0] ?? '',
    subject: decodeHeader(m.Content.Headers.Subject?.[0] ?? ''),
    template: m.Content.Headers['X-Biobloom-Template']?.[0] ?? '',
  }));
}

async function mailsContaining(marker: string): Promise<Mail[]> {
  return (await allMails()).filter((m) => m.subject.includes(marker));
}

async function mailsTo(marker: string): Promise<Mail[]> {
  return (await allMails()).filter((m) => m.to.includes(marker));
}

// Listeners send asynchronously after emit(), so poll until the expected count arrives
async function waitFor(find: () => Promise<Mail[]>, expected: number): Promise<Mail[]> {
  let mails: Mail[] = [];
  for (let i = 0; i < 40 && mails.length < expected; i++) {
    mails = await find();
    if (mails.length < expected) await new Promise((r) => setTimeout(r, 150));
  }
  return mails;
}

const waitForMails = (marker: string, expected: number) =>
  waitFor(() => mailsContaining(marker), expected);

const settle = () => new Promise((r) => setTimeout(r, 1000));

describe('Notifications and the batch expiry sweep (e2e)', () => {
  const stamp = `sweep${Date.now()}`;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const daysFromToday = (n: number) => new Date(today.getTime() + n * 86_400_000);

  const boot = async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    return app;
  };

  // One product with a variant, plus batches created per test
  const createVariant = async (prisma: PrismaService, suffix: string) => {
    const product = await prisma.product.create({
      data: {
        slug: `${stamp}-${suffix}`,
        name: `${stamp} Coconut Jaggery ${suffix}`,
        description: 'Expiry sweep fixture',
        category: 'jaggery',
        basePrice: '650.00',
        unitWeightGrams: 500,
        variants: {
          create: {
            sku: `${stamp}-${suffix}-500`,
            name: '500g',
            size: '500 g',
            price: '650.00',
            unitWeightGrams: 500,
          },
        },
      },
      include: { variants: true },
    });
    return product.variants[0].id;
  };

  const createBatch = (
    prisma: PrismaService,
    variantId: string,
    batchNumber: string,
    expiresInDays: number,
    status: 'ACTIVE' | 'DEPLETED' = 'ACTIVE',
  ) =>
    prisma.productBatch.create({
      data: {
        productVariantId: variantId,
        batchNumber: `${stamp}-${batchNumber}`,
        manufacturedDate: daysFromToday(-60),
        expiryDate: daysFromToday(expiresInDays),
        initialQuantity: 20,
        currentQuantity: status === 'DEPLETED' ? 0 : 20,
        status,
      },
    });

  describe('with the mail server running', () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let variantId: string;
    const batch: Record<'soon' | 'today' | 'yesterday' | 'depleted' | 'later', string> = {
      soon: '',
      today: '',
      yesterday: '',
      depleted: '',
      later: '',
    };
    const events: Array<{ name: string; batchId: string; daysUntilExpiry?: number }> = [];
    const activeAdmins = [`ops.${stamp}@example.com`, `owner.${stamp}@example.com`];
    const otherStaff = [`retired.${stamp}@example.com`, `packer.${stamp}@example.com`];

    beforeAll(async () => {
      app = await boot();
      prisma = app.get(PrismaService);

      const emitter = app.get(EventEmitter2);
      for (const name of ['batch.expiringSoon', 'batch.expired']) {
        emitter.on(name, (p: { batchId: string; daysUntilExpiry?: number }) =>
          events.push({ name, batchId: p.batchId, daysUntilExpiry: p.daysUntilExpiry }),
        );
      }

      const passwordHash = await bcrypt.hash('Harvest2026', 4);
      await prisma.adminUser.createMany({
        data: [
          { email: activeAdmins[0], passwordHash, name: 'Ops', role: 'ADMIN' },
          { email: activeAdmins[1], passwordHash, name: 'Owner', role: 'ADMIN' },
          { email: otherStaff[0], passwordHash, name: 'Retired', role: 'ADMIN', active: false },
          { email: otherStaff[1], passwordHash, name: 'Packer', role: 'FULFILMENT_STAFF' },
        ],
      });

      variantId = await createVariant(prisma, 'main');
      batch.soon = (await createBatch(prisma, variantId, 'SOON', 5)).id;
      batch.today = (await createBatch(prisma, variantId, 'TODAY', 0)).id;
      batch.yesterday = (await createBatch(prisma, variantId, 'YESTERDAY', -1)).id;
      batch.depleted = (await createBatch(prisma, variantId, 'DEPLETED', 3, 'DEPLETED')).id;
      batch.later = (await createBatch(prisma, variantId, 'LATER', 30)).id;
    });

    afterAll(async () => {
      if (prisma) {
        await prisma.product.deleteMany({ where: { slug: { startsWith: stamp } } });
        await prisma.adminUser.deleteMany({ where: { email: { contains: stamp } } });
      }
      await app?.close();
    });

    const statusOf = async (id: string) =>
      (await prisma.productBatch.findUniqueOrThrow({ where: { id } })).status;
    const ourEvents = () => events.filter((e) => Object.values(batch).includes(e.batchId));

    it('updates batch statuses and emits one event per batch', async () => {
      await app.get(ExpiryCronService).sweep();

      expect(await statusOf(batch.soon)).toBe('EXPIRING_SOON');
      expect(await statusOf(batch.today)).toBe('EXPIRING_SOON');
      expect(await statusOf(batch.yesterday)).toBe('EXPIRED');
      expect(await statusOf(batch.depleted)).toBe('DEPLETED');
      expect(await statusOf(batch.later)).toBe('ACTIVE');

      expect(ourEvents()).toEqual(
        expect.arrayContaining([
          { name: 'batch.expiringSoon', batchId: batch.soon, daysUntilExpiry: 5 },
          { name: 'batch.expiringSoon', batchId: batch.today, daysUntilExpiry: 0 },
          { name: 'batch.expired', batchId: batch.yesterday, daysUntilExpiry: undefined },
        ]),
      );
      expect(ourEvents()).toHaveLength(3);
    });

    it('emails every active admin, and no one else, through MailHog', async () => {
      const mails = await waitForMails(stamp, 4);

      expect(mails.every((m) => m.template === TEMPLATE_ID)).toBe(true);
      expect(mails.map((m) => `${m.to} ${m.subject}`).sort()).toEqual(
        [
          `${activeAdmins[0]} Batch ${stamp}-SOON expires soon`,
          `${activeAdmins[0]} Batch ${stamp}-TODAY expires soon`,
          `${activeAdmins[1]} Batch ${stamp}-SOON expires soon`,
          `${activeAdmins[1]} Batch ${stamp}-TODAY expires soon`,
        ].sort(),
      );
    });

    it('keeps a batch that expires today sellable until the day ends', async () => {
      // SOON (20) + TODAY (20) + LATER (20); YESTERDAY and DEPLETED are excluded
      expect(await app.get(InventoryService).availableStock(variantId)).toBe(60);
    });

    it('changes nothing and sends nothing on a second run the same day', async () => {
      const eventsBefore = ourEvents().length;
      const mailsBefore = (await mailsContaining(stamp)).length;

      await app.get(ExpiryCronService).sweep();
      await settle();

      expect(ourEvents()).toHaveLength(eventsBefore);
      expect(await mailsContaining(stamp)).toHaveLength(mailsBefore);
      expect(await statusOf(batch.soon)).toBe('EXPIRING_SOON');
      expect(await statusOf(batch.yesterday)).toBe('EXPIRED');
    });
  });

  describe('with the mail server unreachable', () => {
    let app: INestApplication;
    let prisma: PrismaService;
    const smtpPort = process.env.SMTP_PORT;
    const admin = `unreachable.${stamp}@example.com`;

    beforeAll(async () => {
      // Nothing listens on port 1, so every send fails
      process.env.SMTP_PORT = '1';
      app = await boot();
      prisma = app.get(PrismaService);
      await prisma.adminUser.create({
        data: {
          email: admin,
          passwordHash: await bcrypt.hash('Harvest2026', 4),
          name: 'Ops',
          role: 'ADMIN',
        },
      });
    });

    afterAll(async () => {
      if (smtpPort === undefined) delete process.env.SMTP_PORT;
      else process.env.SMTP_PORT = smtpPort;
      if (prisma) {
        await prisma.product.deleteMany({ where: { slug: { startsWith: stamp } } });
        await prisma.adminUser.deleteMany({ where: { email: admin } });
      }
      await app?.close();
    });

    it('still finishes the sweep and updates statuses when the alert cannot be sent', async () => {
      const variantId = await createVariant(prisma, 'offline');
      const soon = await createBatch(prisma, variantId, 'OFFLINE-SOON', 4);

      await expect(app.get(ExpiryCronService).sweep()).resolves.toMatchObject({
        expiringSoonCount: expect.any(Number),
      });
      await settle();

      expect((await prisma.productBatch.findUniqueOrThrow({ where: { id: soon.id } })).status).toBe(
        'EXPIRING_SOON',
      );
      expect(await mailsContaining(`${stamp}-OFFLINE`)).toHaveLength(0);
    });
  });

  describe('transactional emails', () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let notifications: NotificationsService;
    const customerEmail = `shopper.${stamp}@example.com`;
    const sellerEmail = `kitchen.${stamp}@example.com`;
    const ids = { customer: '', order: '', subscription: '' };

    beforeAll(async () => {
      app = await boot();
      prisma = app.get(PrismaService);
      notifications = app.get(NotificationsService);

      const customer = await prisma.customer.create({
        data: {
          email: customerEmail,
          passwordHash: await bcrypt.hash('Harvest2026', 4),
          name: 'Shopper',
        },
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
      const variantId = await createVariant(prisma, 'mail');
      const order = await prisma.order.create({
        data: {
          customerId: customer.id,
          shippingAddressId: address.id,
          totalAmount: '1500.00',
          totalWeight: '500',
          shippingFee: '250.00',
          currency: 'LKR',
        },
      });
      const subscription = await prisma.subscription.create({
        data: {
          customerId: customer.id,
          productVariantId: variantId,
          shippingAddressId: address.id,
          frequencyDays: 30,
          discountRate: '0.1000',
          nextBillingDate: daysFromToday(30),
          paymentTokenEncrypted: new Uint8Array([1, 2, 3]),
          paymentGateway: 'STRIPE',
        },
      });
      ids.customer = customer.id;
      ids.order = order.id;
      ids.subscription = subscription.id;
    });

    afterAll(async () => {
      if (prisma) {
        await prisma.subscription.deleteMany({ where: { customerId: ids.customer } });
        await prisma.order.deleteMany({ where: { customerId: ids.customer } });
        await prisma.customer.deleteMany({ where: { email: customerEmail } });
        await prisma.product.deleteMany({ where: { slug: { startsWith: stamp } } });
      }
      await app?.close();
    });

    it('emails the customer about order, subscription and refund events', async () => {
      const ref = `#${ids.order.slice(0, 8)}`;
      notifications.emitOrderConfirmed({ orderId: ids.order });
      notifications.emitOrderShipped({ orderId: ids.order, actorId: 'staff' });
      notifications.emitOrderDelivered({ orderId: ids.order, actorId: 'rider' });
      notifications.emitSubscriptionRenewed({
        subscriptionId: ids.subscription,
        customerId: ids.customer,
        orderId: ids.order,
        amount: '1350.00',
        currency: 'LKR',
      });
      notifications.emitRefundApproved({
        refundRequestId: 'refund-1',
        customerId: ids.customer,
        orderId: ids.order,
        amount: '450.00',
      });

      const mails = await waitFor(() => mailsTo(customerEmail), 5);

      expect(mails.map((m) => `${m.template} | ${m.subject}`).sort()).toEqual(
        [
          `d-order-confirmed | Order ${ref} confirmed`,
          `d-order-shipped | Order ${ref} has shipped`,
          `d-order-delivered | Order ${ref} delivered — how was it?`,
          'd-subscription-renewed | Your Subscribe & Save renewed',
          'd-refund-issued | Your refund is on the way',
        ].sort(),
      );
    });

    it('emails the customer when a renewal is delayed for stock or the charge fails', async () => {
      notifications.emitSubscriptionStockDelayed({
        subscriptionId: ids.subscription,
        customerId: ids.customer,
        productVariantId: 'v',
        requested: 3,
        available: 1,
      });
      notifications.emitSubscriptionChargeFailed({
        subscriptionId: ids.subscription,
        customerId: ids.customer,
        reason: 'card_declined',
      });

      const mails = await waitFor(
        async () =>
          (await mailsTo(customerEmail)).filter((m) =>
            ['d-subscription-stock-delayed', 'd-subscription-charge-failed'].includes(m.template),
          ),
        2,
      );
      expect(mails.map((m) => `${m.template} | ${m.subject}`).sort()).toEqual([
        'd-subscription-charge-failed | We could not charge your Subscribe & Save',
        'd-subscription-stock-delayed | Your Subscribe & Save delivery is delayed',
      ]);
    });

    it('confirms a cancellation by email when the customer cancels', async () => {
      await app.get(SubscriptionsService).cancel(ids.customer, ids.subscription);

      const mails = await waitFor(
        async () =>
          (await mailsTo(customerEmail)).filter((m) => m.subject === 'Subscription cancelled'),
        1,
      );
      expect(mails).toEqual([
        {
          to: customerEmail,
          subject: 'Subscription cancelled',
          template: 'd-subscription-cancelled',
        },
      ]);
    });

    it('welcomes an approved seller', async () => {
      notifications.emitSellerApproved({
        sellerId: 'seller-1',
        email: sellerEmail,
        businessName: 'Kitchen Amma',
        approvedByAdminId: 'admin-1',
      });

      const mails = await waitFor(() => mailsTo(sellerEmail), 1);
      expect(mails.map((m) => m.template)).toEqual(['d-seller-approved']);
    });

    it('sends nothing for events that are only logged', async () => {
      const before = (await mailsTo(stamp)).length;
      notifications.emitSellerApplied({ sellerId: 's', email: sellerEmail, businessName: 'X' });
      notifications.emitRefundRejected({
        refundRequestId: 'r',
        customerId: ids.customer,
        orderId: ids.order,
        reason: 'Too late',
      });
      await settle();

      expect(await mailsTo(stamp)).toHaveLength(before);
    });
  });
});
