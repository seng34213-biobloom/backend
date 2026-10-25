import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { PaymentGateway } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { StaleOrderCronService } from '../src/orders/stale-order-cron.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { fixtureEmail, fixtureNamespace } from './helpers/fixtures';

/**
 * Unpaid checkouts past the timeout: the order is cancelled, its pending
 * payment fails, its units go back to the batch and a SYSTEM audit entry is
 * written. A recent unpaid order keeps its stock.
 */
describe('Stale unpaid orders (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cleanup: StaleOrderCronService;

  const stamp = fixtureNamespace('stale');
  const ids = { customer: '', batch: '', stale: '', recent: '' };

  // An order of 2 units placed `minutesAgo` minutes ago, with its pending payment
  const placeOrder = async (minutesAgo: number, address: string, variant: string) => {
    const order = await prisma.order.create({
      data: {
        customerId: ids.customer,
        shippingAddressId: address,
        totalAmount: '2350.00',
        totalWeight: '600',
        shippingFee: '350.00',
        placedAt: new Date(Date.now() - minutesAgo * 60_000),
        items: {
          create: {
            productVariantId: variant,
            batchId: ids.batch,
            quantity: 2,
            unitPriceSnapshot: '1000.00',
            lineTotal: '2000.00',
          },
        },
        payments: {
          create: {
            gateway: PaymentGateway.STRIPE,
            gatewayPaymentId: `pi_${stamp}_${minutesAgo}`,
            amount: '2350.00',
          },
        },
      },
    });
    return order.id;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    cleanup = app.get(StaleOrderCronService);

    const customer = await prisma.customer.create({
      data: {
        email: fixtureEmail(stamp, 'shopper'),
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
    const product = await prisma.product.create({
      data: {
        slug: `${stamp}-tea`,
        name: `${stamp} Ceylon Tea`,
        description: 'Stale order fixture',
        category: 'tea',
        basePrice: '1000.00',
        unitWeightGrams: 300,
        variants: {
          create: {
            sku: `${stamp}-300`,
            name: '300g',
            size: '300 g',
            price: '1000.00',
            unitWeightGrams: 300,
          },
        },
      },
      include: { variants: true },
    });
    // 10 received, 4 already taken by the two unpaid checkouts below
    const batch = await prisma.productBatch.create({
      data: {
        productVariantId: product.variants[0].id,
        batchNumber: `${stamp}-B1`,
        manufacturedDate: new Date(Date.now() - 10 * 86_400_000),
        expiryDate: new Date(Date.now() + 90 * 86_400_000),
        initialQuantity: 10,
        currentQuantity: 6,
      },
    });
    ids.customer = customer.id;
    ids.batch = batch.id;
    ids.stale = await placeOrder(120, address.id, product.variants[0].id);
    ids.recent = await placeOrder(5, address.id, product.variants[0].id);

    await cleanup.cancelStale();
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.auditLog.deleteMany({ where: { targetId: { in: [ids.stale, ids.recent] } } });
      await prisma.order.deleteMany({ where: { customerId: ids.customer } });
      await prisma.address.deleteMany({ where: { customerId: ids.customer } });
      await prisma.customer.deleteMany({ where: { id: ids.customer } });
      await prisma.product.deleteMany({ where: { slug: { startsWith: stamp } } });
    }
    await app?.close();
  });

  it('cancels the order unpaid past the timeout and fails its payment', async () => {
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: ids.stale },
      include: { payments: true },
    });
    expect(order).toMatchObject({ status: 'CANCELLED', paymentStatus: 'FAILED' });
    expect(order.cancelledAt).not.toBeNull();
    expect(order.payments.map((p) => p.status)).toEqual(['FAILED']);
  });

  it('returns its units to the batch and keeps the recent order reserved', async () => {
    const batch = await prisma.productBatch.findUniqueOrThrow({ where: { id: ids.batch } });
    expect(batch.currentQuantity).toBe(8);
    const recent = await prisma.order.findUniqueOrThrow({ where: { id: ids.recent } });
    expect(recent.status).toBe('PENDING_PAYMENT');
  });

  it('writes a SYSTEM audit entry for the cancellation', async () => {
    const entries = await prisma.auditLog.findMany({ where: { targetId: ids.stale } });
    expect(entries).toEqual([
      expect.objectContaining({
        actorType: 'SYSTEM',
        action: 'order.cancelled',
        targetType: 'Order',
        metadata: expect.objectContaining({ reason: 'payment_timeout', timeoutMinutes: 30 }),
      }),
    ]);
  });

  it('changes nothing on a second run', async () => {
    await cleanup.cancelStale();
    expect(await prisma.auditLog.count({ where: { targetId: ids.stale } })).toBe(1);
    const batch = await prisma.productBatch.findUniqueOrThrow({ where: { id: ids.batch } });
    expect(batch.currentQuantity).toBe(8);
  });
});
