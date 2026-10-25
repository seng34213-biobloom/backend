import { PaymentGateway, PaymentStatus, Prisma, SubscriptionStatus } from '@prisma/client';
import { CronLockService } from '../common/locks/cron-lock.service';
import { InventoryService } from '../inventory/inventory.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PaymentsService } from '../payments/payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { ShippingService } from '../shipping/shipping.service';
import { BillingCronService } from './billing-cron.service';
import { TokenCipherService } from './token-cipher.service';

describe('BillingCronService', () => {
  const today = new Date('2026-11-01T00:00:00.000Z');
  const dueDate = new Date('2026-10-30T00:00:00.000Z');

  let svc: BillingCronService;
  let prisma: {
    subscription: { findMany: jest.Mock; findUniqueOrThrow: jest.Mock; updateMany: jest.Mock };
    payment: { create: jest.Mock };
    $transaction: jest.Mock;
  };
  let tx: {
    order: { create: jest.Mock };
    payment: { create: jest.Mock };
    subscription: { updateMany: jest.Mock };
  };
  let inventory: { availableStock: jest.Mock; decrementForVariant: jest.Mock };
  let shipping: { calculate: jest.Mock };
  let payments: { chargeStoredToken: jest.Mock };
  let notifications: {
    emitSubscriptionRenewed: jest.Mock;
    emitSubscriptionStockDelayed: jest.Mock;
    emitSubscriptionChargeFailed: jest.Mock;
  };
  let cipher: { decrypt: jest.Mock };
  let locks: { runExclusive: jest.Mock };

  const subscription = (overrides: Record<string, unknown> = {}) => ({
    id: 'sub-1',
    customerId: 'cust-1',
    productVariantId: 'var-1',
    shippingAddressId: 'addr-1',
    frequencyDays: 30,
    discountRate: new Prisma.Decimal('0.1000'),
    quantity: 2,
    status: SubscriptionStatus.ACTIVE,
    nextBillingDate: dueDate,
    paymentTokenEncrypted: new Uint8Array([1, 2, 3]),
    paymentGateway: PaymentGateway.STRIPE,
    variant: { price: new Prisma.Decimal('1000.00'), unitWeightGrams: 300, active: true },
    ...overrides,
  });

  beforeEach(() => {
    tx = {
      order: { create: jest.fn().mockResolvedValue({ id: 'order-1' }) },
      payment: { create: jest.fn().mockResolvedValue({}) },
      subscription: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    prisma = {
      subscription: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'sub-1', nextBillingDate: dueDate, frequencyDays: 30 }]),
        findUniqueOrThrow: jest.fn().mockResolvedValue(subscription()),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      payment: { create: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn((callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    };
    inventory = {
      availableStock: jest.fn().mockResolvedValue(10),
      decrementForVariant: jest.fn().mockResolvedValue([
        { batchId: 'batch-1', qtyTaken: 1, depleted: true },
        { batchId: 'batch-2', qtyTaken: 1, depleted: false },
      ]),
    };
    shipping = {
      calculate: jest.fn().mockResolvedValue({
        totalWeightG: 600,
        feeLkr: '500.00',
        bracketId: 'rate-2',
        bracketLabel: '501 g - 1 kg',
      }),
    };
    payments = {
      chargeStoredToken: jest.fn().mockResolvedValue({ succeeded: true, gatewayPaymentId: 'pi_1' }),
    };
    notifications = {
      emitSubscriptionRenewed: jest.fn(),
      emitSubscriptionStockDelayed: jest.fn(),
      emitSubscriptionChargeFailed: jest.fn(),
    };
    cipher = { decrypt: jest.fn().mockResolvedValue('cus_1:pm_1') };
    locks = {
      runExclusive: jest.fn((_name: string, _ttl: number, fn: () => Promise<unknown>) => fn()),
    };

    svc = new BillingCronService(
      prisma as unknown as PrismaService,
      inventory as unknown as InventoryService,
      shipping as unknown as ShippingService,
      payments as unknown as PaymentsService,
      notifications as unknown as NotificationsService,
      cipher as unknown as TokenCipherService,
      locks as unknown as CronLockService,
    );
  });

  it('selects only ACTIVE subscriptions due on or before the run date', async () => {
    prisma.subscription.findMany.mockResolvedValue([]);

    await expect(svc.runBilling(today)).resolves.toEqual({
      due: 0,
      renewed: 0,
      outOfStock: 0,
      chargeFailed: 0,
      errored: 0,
    });
    expect(prisma.subscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: SubscriptionStatus.ACTIVE, nextBillingDate: { lte: today } },
      }),
    );
  });

  it('charges the discounted price plus shipping and creates the paid order', async () => {
    await expect(svc.runBilling(today)).resolves.toMatchObject({ due: 1, renewed: 1 });

    // 2 × 1000.00 × 0.9 + 500.00 shipping
    expect(payments.chargeStoredToken).toHaveBeenCalledWith(
      expect.objectContaining({
        gateway: PaymentGateway.STRIPE,
        token: 'cus_1:pm_1',
        amount: '2300.00',
        currency: 'LKR',
        idempotencyKey: 'sub-1:2026-10-30',
      }),
    );
    expect(inventory.decrementForVariant).toHaveBeenCalledWith('var-1', 2, tx);
    const order = tx.order.create.mock.calls[0][0].data;
    expect(order).toMatchObject({
      customerId: 'cust-1',
      shippingAddressId: 'addr-1',
      status: 'PAID',
      paymentStatus: 'PAID',
      totalWeight: '600.00',
      shippingFee: '500.00',
    });
    expect(order.totalAmount.toFixed(2)).toBe('2300.00');
    expect(
      order.items.create.map((i: { batchId: string; unitPriceSnapshot: Prisma.Decimal }) => [
        i.batchId,
        i.unitPriceSnapshot.toFixed(2),
      ]),
    ).toEqual([
      ['batch-1', '900.00'],
      ['batch-2', '900.00'],
    ]);
    expect(tx.payment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: 'order-1',
        subscriptionId: 'sub-1',
        gatewayPaymentId: 'pi_1',
        status: PaymentStatus.PAID,
      }),
    });
    expect(notifications.emitSubscriptionRenewed).toHaveBeenCalledWith({
      subscriptionId: 'sub-1',
      customerId: 'cust-1',
      orderId: 'order-1',
      amount: '2300.00',
      currency: 'LKR',
    });
  });

  it('advances the billing date from its previous value, not from the run date', async () => {
    await svc.runBilling(today);

    expect(tx.subscription.updateMany).toHaveBeenCalledWith({
      where: { id: 'sub-1', nextBillingDate: dueDate },
      data: { nextBillingDate: new Date('2026-11-29T00:00:00.000Z') },
    });
  });

  it('does not charge when stock is short, emits stockDelayed and advances', async () => {
    inventory.availableStock.mockResolvedValue(1);

    await expect(svc.runBilling(today)).resolves.toMatchObject({ outOfStock: 1, renewed: 0 });
    expect(payments.chargeStoredToken).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(notifications.emitSubscriptionStockDelayed).toHaveBeenCalledWith({
      subscriptionId: 'sub-1',
      customerId: 'cust-1',
      productVariantId: 'var-1',
      requested: 2,
      available: 1,
    });
    expect(prisma.subscription.updateMany).toHaveBeenCalledWith({
      where: { id: 'sub-1', nextBillingDate: dueDate },
      data: { nextBillingDate: new Date('2026-11-29T00:00:00.000Z') },
    });
  });

  it('treats a variant that is no longer sold as out of stock', async () => {
    prisma.subscription.findUniqueOrThrow.mockResolvedValue(
      subscription({
        variant: { price: new Prisma.Decimal('1000.00'), unitWeightGrams: 300, active: false },
      }),
    );

    await expect(svc.runBilling(today)).resolves.toMatchObject({ outOfStock: 1 });
    expect(inventory.availableStock).not.toHaveBeenCalled();
    expect(payments.chargeStoredToken).not.toHaveBeenCalled();
  });

  it('records a declined charge without an order or stock change, and advances', async () => {
    payments.chargeStoredToken.mockResolvedValue({
      succeeded: false,
      gatewayPaymentId: 'pi_declined',
      failureReason: 'insufficient_funds',
    });

    await expect(svc.runBilling(today)).resolves.toMatchObject({ chargeFailed: 1, renewed: 0 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(inventory.decrementForVariant).not.toHaveBeenCalled();
    expect(prisma.payment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        subscriptionId: 'sub-1',
        gatewayPaymentId: 'pi_declined',
        status: PaymentStatus.FAILED,
        rawPayload: { failureReason: 'insufficient_funds' },
      }),
    });
    expect(notifications.emitSubscriptionChargeFailed).toHaveBeenCalledWith({
      subscriptionId: 'sub-1',
      customerId: 'cust-1',
      reason: 'insufficient_funds',
    });
    expect(prisma.subscription.updateMany).toHaveBeenCalledTimes(1);
  });

  it('keeps going after one subscription fails, and still advances the failed one', async () => {
    prisma.subscription.findMany.mockResolvedValue([
      { id: 'sub-bad', nextBillingDate: dueDate, frequencyDays: 14 },
      { id: 'sub-1', nextBillingDate: dueDate, frequencyDays: 30 },
    ]);
    prisma.subscription.findUniqueOrThrow
      .mockRejectedValueOnce(new Error('decrypt failed'))
      .mockResolvedValueOnce(subscription());

    await expect(svc.runBilling(today)).resolves.toMatchObject({
      due: 2,
      renewed: 1,
      errored: 1,
    });
    expect(prisma.subscription.updateMany).toHaveBeenCalledWith({
      where: { id: 'sub-bad', nextBillingDate: dueDate },
      data: { nextBillingDate: new Date('2026-11-13T00:00:00.000Z') },
    });
  });

  it('bills from the start of today under the daily billing lock', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-01T06:00:00.000Z'));
    try {
      await svc.runDaily();
    } finally {
      jest.useRealTimers();
    }
    expect(locks.runExclusive).toHaveBeenCalledWith(
      'billing:2026-11-01',
      3600,
      expect.any(Function),
    );
    expect(prisma.subscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: SubscriptionStatus.ACTIVE, nextBillingDate: { lte: today } },
      }),
    );
  });

  it('charges nothing and creates no order when another instance holds the lock', async () => {
    locks.runExclusive.mockResolvedValue(null);

    await expect(svc.runDaily()).resolves.toBeNull();
    expect(prisma.subscription.findMany).not.toHaveBeenCalled();
    expect(payments.chargeStoredToken).not.toHaveBeenCalled();
    expect(tx.order.create).not.toHaveBeenCalled();
  });
});
