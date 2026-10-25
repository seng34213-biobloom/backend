import { INestApplication } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { PaymentGateway, SubscriptionStatus } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { BillingCronService } from '../src/subscriptions/billing-cron.service';
import { addDaysUtc, startOfTodayUtc } from '../src/subscriptions/subscriptions.service';
import { TokenCipherService } from '../src/subscriptions/token-cipher.service';
import { fixtureEmail, fixtureNamespace } from './helpers/fixtures';

/**
 * SDS §5.4 against Postgres and pgcrypto: only ACTIVE and due subscriptions
 * are billed, a paid renewal creates a PAID order with FIFO stock, a declined
 * token or short stock creates no order and takes no stock, and every billed
 * subscription's date moves one interval on from its previous value.
 */
describe('Subscription billing (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let billing: BillingCronService;
  let cipher: TokenCipherService;

  const stamp = fixtureNamespace('billing');
  const today = startOfTodayUtc();
  const twoDaysAgo = addDaysUtc(today, -2);
  const events: Array<{ name: string; subscriptionId: string }> = [];
  const ids = { customer: '', address: '', variant: '', scarceVariant: '', batch: '' };
  const subs: Record<
    'paid' | 'declined' | 'scarce' | 'paused' | 'cancelled' | 'notDue',
    { id: string; next: Date }
  > = {
    paid: { id: '', next: twoDaysAgo },
    declined: { id: '', next: today },
    scarce: { id: '', next: today },
    paused: { id: '', next: today },
    cancelled: { id: '', next: today },
    notDue: { id: '', next: addDaysUtc(today, 1) },
  };

  const subscribe = async (
    variantId: string,
    token: string,
    nextBillingDate: Date,
    status: SubscriptionStatus = SubscriptionStatus.ACTIVE,
  ) =>
    (
      await prisma.subscription.create({
        data: {
          customerId: ids.customer,
          productVariantId: variantId,
          shippingAddressId: ids.address,
          frequencyDays: 30,
          discountRate: '0.1000',
          quantity: 2,
          status,
          nextBillingDate,
          paymentTokenEncrypted: new Uint8Array(await cipher.encrypt(token)),
          paymentGateway: PaymentGateway.STRIPE,
        },
      })
    ).id;

  const nextBillingDate = async (id: string) =>
    (await prisma.subscription.findUniqueOrThrow({ where: { id } })).nextBillingDate;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    billing = app.get(BillingCronService);
    cipher = app.get(TokenCipherService);

    const emitter = app.get(EventEmitter2);
    for (const name of [
      'subscription.renewed',
      'subscription.chargeFailed',
      'subscription.stockDelayed',
    ]) {
      emitter.on(name, (p: { subscriptionId: string }) =>
        events.push({ name, subscriptionId: p.subscriptionId }),
      );
    }

    const customer = await prisma.customer.create({
      data: {
        email: fixtureEmail(stamp, 'subscriber'),
        passwordHash: await bcrypt.hash('Harvest2026', 4),
        name: 'Subscriber',
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
        slug: `${stamp}-jaggery`,
        name: `${stamp} Kithul Jaggery`,
        description: 'Billing fixture',
        category: 'sweeteners',
        basePrice: '1000.00',
        unitWeightGrams: 300,
        variants: {
          create: [
            {
              sku: `${stamp}-300`,
              name: '300g',
              size: '300 g',
              price: '1000.00',
              unitWeightGrams: 300,
            },
            {
              sku: `${stamp}-scarce`,
              name: '300g limited',
              size: '300 g',
              price: '1000.00',
              unitWeightGrams: 300,
            },
          ],
        },
      },
      include: { variants: { orderBy: { sku: 'asc' } } },
    });
    const [variant, scarceVariant] = product.variants;
    const batch = await prisma.productBatch.create({
      data: {
        productVariantId: variant.id,
        batchNumber: `${stamp}-B1`,
        manufacturedDate: addDaysUtc(today, -10),
        expiryDate: addDaysUtc(today, 90),
        initialQuantity: 50,
        currentQuantity: 50,
      },
    });
    Object.assign(ids, {
      customer: customer.id,
      address: address.id,
      variant: variant.id,
      scarceVariant: scarceVariant.id,
      batch: batch.id,
    });

    subs.paid.id = await subscribe(variant.id, 'cus_billing:pm_ok', subs.paid.next);
    subs.declined.id = await subscribe(variant.id, 'tok_will_fail', subs.declined.next);
    subs.scarce.id = await subscribe(scarceVariant.id, 'cus_billing:pm_ok', subs.scarce.next);
    subs.paused.id = await subscribe(
      variant.id,
      'cus_billing:pm_ok',
      subs.paused.next,
      SubscriptionStatus.PAUSED,
    );
    subs.cancelled.id = await subscribe(
      variant.id,
      'cus_billing:pm_ok',
      subs.cancelled.next,
      SubscriptionStatus.CANCELLED,
    );
    subs.notDue.id = await subscribe(variant.id, 'cus_billing:pm_ok', subs.notDue.next);

    await billing.runBilling(today);
  });

  afterAll(async () => {
    if (prisma) {
      const subscriptionIds = Object.values(subs).map((s) => s.id);
      await prisma.payment.deleteMany({ where: { subscriptionId: { in: subscriptionIds } } });
      await prisma.order.deleteMany({ where: { customerId: ids.customer } });
      await prisma.subscription.deleteMany({ where: { id: { in: subscriptionIds } } });
      await prisma.address.deleteMany({ where: { customerId: ids.customer } });
      await prisma.customer.deleteMany({ where: { id: ids.customer } });
      await prisma.product.deleteMany({ where: { slug: { startsWith: stamp } } });
    }
    await app?.close();
  });

  it('bills a due subscription: PAID order with FIFO stock and a PAID payment', async () => {
    const payments = await prisma.payment.findMany({ where: { subscriptionId: subs.paid.id } });
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ status: 'PAID', currency: 'LKR' });
    // 2 × 1000.00 × 0.9 + 500.00 shipping for 600 g
    expect(payments[0].amount.toFixed(2)).toBe('2300.00');

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: payments[0].orderId ?? '' },
      include: { items: true },
    });
    expect(order).toMatchObject({ status: 'PAID', paymentStatus: 'PAID' });
    expect(order.totalAmount.toFixed(2)).toBe('2300.00');
    expect(order.items).toEqual([
      expect.objectContaining({ productVariantId: ids.variant, batchId: ids.batch, quantity: 2 }),
    ]);

    const batch = await prisma.productBatch.findUniqueOrThrow({ where: { id: ids.batch } });
    expect(batch.currentQuantity).toBe(48);
    expect(events).toContainEqual({ name: 'subscription.renewed', subscriptionId: subs.paid.id });
  });

  it('records a declined token without an order and without taking stock', async () => {
    const payments = await prisma.payment.findMany({
      where: { subscriptionId: subs.declined.id },
    });
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ status: 'FAILED', orderId: null });
    expect(events).toContainEqual({
      name: 'subscription.chargeFailed',
      subscriptionId: subs.declined.id,
    });
    // Only the paid renewal took stock
    const batch = await prisma.productBatch.findUniqueOrThrow({ where: { id: ids.batch } });
    expect(batch.currentQuantity).toBe(48);
  });

  it('does not charge when stock is short', async () => {
    expect(await prisma.payment.count({ where: { subscriptionId: subs.scarce.id } })).toBe(0);
    expect(events).toContainEqual({
      name: 'subscription.stockDelayed',
      subscriptionId: subs.scarce.id,
    });
  });

  it('creates one order for this customer, from the paid renewal only', async () => {
    expect(await prisma.order.count({ where: { customerId: ids.customer } })).toBe(1);
  });

  it('advances every billed date one interval from its previous value', async () => {
    expect(await nextBillingDate(subs.paid.id)).toEqual(addDaysUtc(twoDaysAgo, 30));
    expect(await nextBillingDate(subs.declined.id)).toEqual(addDaysUtc(today, 30));
    expect(await nextBillingDate(subs.scarce.id)).toEqual(addDaysUtc(today, 30));
  });

  it('leaves PAUSED, CANCELLED and not-yet-due subscriptions untouched', async () => {
    for (const key of ['paused', 'cancelled', 'notDue'] as const) {
      expect(await nextBillingDate(subs[key].id)).toEqual(subs[key].next);
      expect(await prisma.payment.count({ where: { subscriptionId: subs[key].id } })).toBe(0);
    }
    const touched = events.map((e) => e.subscriptionId);
    expect(touched).not.toContain(subs.paused.id);
    expect(touched).not.toContain(subs.cancelled.id);
    expect(touched).not.toContain(subs.notDue.id);
  });
});
