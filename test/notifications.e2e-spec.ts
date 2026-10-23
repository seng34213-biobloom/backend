import { INestApplication } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../src/app.module';
import { ExpiryCronService } from '../src/batches/expiry-cron.service';
import { InventoryService } from '../src/inventory/inventory.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Daily expiry sweep against Postgres, with alert emails checked in MailHog
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

async function mailsContaining(marker: string): Promise<Mail[]> {
  const res = await fetch(`${MAILHOG}/api/v2/messages?limit=500`);
  const json = (await res.json()) as { items: MailHogItem[] };
  return json.items
    .map((m) => ({
      to: m.Content.Headers.To?.[0] ?? '',
      subject: m.Content.Headers.Subject?.[0] ?? '',
      template: m.Content.Headers['X-Biobloom-Template']?.[0] ?? '',
    }))
    .filter((m) => m.subject.includes(marker));
}

// Listeners send asynchronously after emit(), so poll until the expected count arrives
async function waitForMails(marker: string, expected: number): Promise<Mail[]> {
  let mails: Mail[] = [];
  for (let i = 0; i < 40 && mails.length < expected; i++) {
    mails = await mailsContaining(marker);
    if (mails.length < expected) await new Promise((r) => setTimeout(r, 150));
  }
  return mails;
}

const settle = () => new Promise((r) => setTimeout(r, 1000));

describe('Batch expiry sweep and admin alerts (e2e)', () => {
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
});
