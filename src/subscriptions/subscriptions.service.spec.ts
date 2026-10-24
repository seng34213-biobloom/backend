import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PaymentGateway, SubscriptionStatus } from '@prisma/client';
import { SubscriptionsService, addDaysUtc, startOfTodayUtc } from './subscriptions.service';
import { TokenCipherService } from './token-cipher.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';

// Variant and product as returned by the subscription select
const VARIANT = {
  id: 'v-1',
  name: 'Wild Honey 250g',
  size: '250 g',
  product: { id: 'p-1', name: 'Wild Honey', slug: 'wild-honey' },
};

function makePrisma() {
  return {
    address: { findUnique: jest.fn() },
    productVariant: { findUnique: jest.fn() },
    subscription: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  } as unknown as jest.Mocked<PrismaService>;
}

function makeCipher(): jest.Mocked<Pick<TokenCipherService, 'encrypt' | 'decrypt'>> {
  return {
    encrypt: jest.fn().mockResolvedValue(Buffer.from('enc-bytes')),
    decrypt: jest.fn().mockResolvedValue('pm_test_xxx'),
  };
}

describe('SubscriptionsService', () => {
  let svc: SubscriptionsService;
  let prisma: jest.Mocked<PrismaService>;
  let cipher: jest.Mocked<Pick<TokenCipherService, 'encrypt' | 'decrypt'>>;
  let notifications: jest.Mocked<Pick<NotificationsService, 'emitSubscriptionCancelled'>>;

  beforeEach(() => {
    prisma = makePrisma();
    cipher = makeCipher();
    notifications = { emitSubscriptionCancelled: jest.fn() };
    svc = new SubscriptionsService(
      prisma,
      cipher as unknown as TokenCipherService,
      notifications as unknown as NotificationsService,
    );
  });

  describe('create', () => {
    function happyPath() {
      (prisma.address.findUnique as jest.Mock).mockResolvedValue({
        id: 'addr-1',
        customerId: 'cust-1',
      });
      (prisma.productVariant.findUnique as jest.Mock).mockResolvedValue({
        id: 'v-1',
        active: true,
      });
      (prisma.subscription.create as jest.Mock).mockImplementation(({ data }) =>
        Promise.resolve({
          id: 's-1',
          customerId: data.customerId,
          productVariantId: data.productVariantId,
          shippingAddressId: data.shippingAddressId,
          frequencyDays: data.frequencyDays,
          discountRate: data.discountRate,
          quantity: data.quantity,
          status: data.status,
          nextBillingDate: data.nextBillingDate,
          paymentGateway: data.paymentGateway,
          cancelledAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          variant: VARIANT,
        }),
      );
    }

    it('encrypts the token, sets ACTIVE + first billing date, locks discount 10%', async () => {
      happyPath();
      const sub = await svc.create('cust-1', {
        productVariantId: 'v-1',
        shippingAddressId: 'addr-1',
        frequencyDays: 30,
        quantity: 1,
        paymentToken: 'pm_test_xxx',
        paymentGateway: PaymentGateway.STRIPE,
      });
      expect(cipher.encrypt).toHaveBeenCalledWith('pm_test_xxx');
      const createArgs = (prisma.subscription.create as jest.Mock).mock.calls[0][0];
      expect(createArgs.data.status).toBe(SubscriptionStatus.ACTIVE);
      expect(createArgs.data.discountRate).toBe('0.1000');
      expect(createArgs.data.quantity).toBe(1);
      // nextBillingDate = today + frequencyDays
      const expected = addDaysUtc(startOfTodayUtc(), 30).getTime();
      expect((createArgs.data.nextBillingDate as Date).getTime()).toBe(expected);
      expect(sub.status).toBe(SubscriptionStatus.ACTIVE);
      expect(sub.discountRate).toBe('0.1000');
      expect(sub).not.toHaveProperty('paymentTokenEncrypted');
    });

    it('rejects an address that does not exist', async () => {
      (prisma.address.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(
        svc.create('cust-1', {
          productVariantId: 'v-1',
          shippingAddressId: 'missing',
          frequencyDays: 30,
          quantity: 1,
          paymentToken: 'pm_test_xxx',
          paymentGateway: PaymentGateway.STRIPE,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects address that does not belong to the customer (§7.5)', async () => {
      (prisma.address.findUnique as jest.Mock).mockResolvedValue({
        id: 'addr-1',
        customerId: 'other-cust',
      });
      await expect(
        svc.create('cust-1', {
          productVariantId: 'v-1',
          shippingAddressId: 'addr-1',
          frequencyDays: 30,
          quantity: 1,
          paymentToken: 'pm_test_xxx',
          paymentGateway: PaymentGateway.STRIPE,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(cipher.encrypt).not.toHaveBeenCalled();
    });

    it('rejects inactive variant', async () => {
      (prisma.address.findUnique as jest.Mock).mockResolvedValue({
        id: 'addr-1',
        customerId: 'cust-1',
      });
      (prisma.productVariant.findUnique as jest.Mock).mockResolvedValue({
        id: 'v-1',
        active: false,
      });
      await expect(
        svc.create('cust-1', {
          productVariantId: 'v-1',
          shippingAddressId: 'addr-1',
          frequencyDays: 30,
          quantity: 1,
          paymentToken: 'pm_test_xxx',
          paymentGateway: PaymentGateway.STRIPE,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('state transitions', () => {
    function ownedSub(overrides: Partial<{ status: SubscriptionStatus; nextBillingDate: Date }>) {
      (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({
        id: 's-1',
        customerId: 'cust-1',
        productVariantId: 'v-1',
        shippingAddressId: 'addr-1',
        frequencyDays: 30,
        discountRate: '0.1000',
        quantity: 1,
        status: overrides.status ?? SubscriptionStatus.ACTIVE,
        nextBillingDate: overrides.nextBillingDate ?? addDaysUtc(startOfTodayUtc(), 30),
        paymentGateway: PaymentGateway.STRIPE,
        cancelledAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        variant: VARIANT,
      });
      (prisma.subscription.update as jest.Mock).mockImplementation(({ data }) =>
        Promise.resolve({
          id: 's-1',
          customerId: 'cust-1',
          productVariantId: 'v-1',
          shippingAddressId: 'addr-1',
          frequencyDays: 30,
          discountRate: '0.1000',
          quantity: 1,
          status: data.status ?? overrides.status ?? SubscriptionStatus.ACTIVE,
          nextBillingDate: data.nextBillingDate ?? new Date(),
          paymentGateway: PaymentGateway.STRIPE,
          cancelledAt: data.cancelledAt ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
          variant: VARIANT,
        }),
      );
    }

    it('pause: ACTIVE → PAUSED', async () => {
      ownedSub({ status: SubscriptionStatus.ACTIVE });
      const out = await svc.pause('cust-1', 's-1');
      const data = (prisma.subscription.update as jest.Mock).mock.calls[0][0].data;
      expect(data.status).toBe(SubscriptionStatus.PAUSED);
      expect(out.status).toBe(SubscriptionStatus.PAUSED);
    });

    it('pause: blocked if CANCELLED', async () => {
      ownedSub({ status: SubscriptionStatus.CANCELLED });
      await expect(svc.pause('cust-1', 's-1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('resume: PAUSED → ACTIVE, pushes overdue nextBillingDate to tomorrow', async () => {
      // Simulate sub paused 5 days past its nextBillingDate.
      const overdue = addDaysUtc(startOfTodayUtc(), -5);
      ownedSub({ status: SubscriptionStatus.PAUSED, nextBillingDate: overdue });
      await svc.resume('cust-1', 's-1');
      const data = (prisma.subscription.update as jest.Mock).mock.calls[0][0].data;
      expect(data.status).toBe(SubscriptionStatus.ACTIVE);
      const tomorrow = addDaysUtc(startOfTodayUtc(), 1).getTime();
      expect((data.nextBillingDate as Date).getTime()).toBe(tomorrow);
    });

    it('resume: keeps future nextBillingDate untouched', async () => {
      const future = addDaysUtc(startOfTodayUtc(), 14);
      ownedSub({ status: SubscriptionStatus.PAUSED, nextBillingDate: future });
      await svc.resume('cust-1', 's-1');
      const data = (prisma.subscription.update as jest.Mock).mock.calls[0][0].data;
      expect((data.nextBillingDate as Date).getTime()).toBe(future.getTime());
    });

    it('cancel: any non-CANCELLED → CANCELLED + cancelledAt', async () => {
      ownedSub({ status: SubscriptionStatus.ACTIVE });
      await svc.cancel('cust-1', 's-1');
      const data = (prisma.subscription.update as jest.Mock).mock.calls[0][0].data;
      expect(data.status).toBe(SubscriptionStatus.CANCELLED);
      expect(data.cancelledAt).toBeInstanceOf(Date);
      expect(notifications.emitSubscriptionCancelled).toHaveBeenCalledWith({
        subscriptionId: 's-1',
        customerId: 'cust-1',
      });
    });

    it('skipNext: ACTIVE only, advances by frequencyDays once', async () => {
      const next = addDaysUtc(startOfTodayUtc(), 10);
      ownedSub({ status: SubscriptionStatus.ACTIVE, nextBillingDate: next });
      await svc.skipNext('cust-1', 's-1');
      const data = (prisma.subscription.update as jest.Mock).mock.calls[0][0].data;
      const expected = addDaysUtc(next, 30).getTime();
      expect((data.nextBillingDate as Date).getTime()).toBe(expected);
    });

    it('skipNext: rejects when not ACTIVE', async () => {
      ownedSub({ status: SubscriptionStatus.PAUSED });
      await expect(svc.skipNext('cust-1', 's-1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('pause: already PAUSED is a no-op', async () => {
      ownedSub({ status: SubscriptionStatus.PAUSED });
      const out = await svc.pause('cust-1', 's-1');
      expect(out.status).toBe(SubscriptionStatus.PAUSED);
      expect(prisma.subscription.update).not.toHaveBeenCalled();
    });

    it('resume: blocked if CANCELLED (terminal)', async () => {
      ownedSub({ status: SubscriptionStatus.CANCELLED });
      await expect(svc.resume('cust-1', 's-1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('resume: already ACTIVE is a no-op', async () => {
      ownedSub({ status: SubscriptionStatus.ACTIVE });
      await svc.resume('cust-1', 's-1');
      expect(prisma.subscription.update).not.toHaveBeenCalled();
    });

    it('cancel: already CANCELLED is a no-op', async () => {
      ownedSub({ status: SubscriptionStatus.CANCELLED });
      const out = await svc.cancel('cust-1', 's-1');
      expect(out.status).toBe(SubscriptionStatus.CANCELLED);
      expect(prisma.subscription.update).not.toHaveBeenCalled();
      expect(notifications.emitSubscriptionCancelled).not.toHaveBeenCalled();
    });

    it('returns 404 for an unknown subscription', async () => {
      (prisma.subscription.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(svc.pause('cust-1', 'missing')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('every mutation requires ownership', async () => {
      (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({
        id: 's-1',
        customerId: 'other-cust',
        status: SubscriptionStatus.ACTIVE,
        nextBillingDate: new Date(),
        frequencyDays: 30,
      });
      await expect(svc.pause('cust-1', 's-1')).rejects.toBeInstanceOf(ForbiddenException);
      await expect(svc.cancel('cust-1', 's-1')).rejects.toBeInstanceOf(ForbiddenException);
      await expect(svc.skipNext('cust-1', 's-1')).rejects.toBeInstanceOf(ForbiddenException);
      await expect(svc.resume('cust-1', 's-1')).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('list', () => {
    it("returns only the customer's subscriptions, newest first, without the token", async () => {
      (prisma.subscription.findMany as jest.Mock).mockResolvedValue([
        { id: 's-2', customerId: 'cust-1', discountRate: '0.1', variant: VARIANT },
        { id: 's-1', customerId: 'cust-1', discountRate: '0.1', variant: VARIANT },
      ]);
      const out = await svc.list('cust-1');
      const args = (prisma.subscription.findMany as jest.Mock).mock.calls[0][0];
      expect(args.where).toEqual({ customerId: 'cust-1' });
      expect(args.orderBy).toEqual({ createdAt: 'desc' });
      expect(args.select.paymentTokenEncrypted).toBeUndefined();
      expect(out.map((s) => s.discountRate)).toEqual(['0.1000', '0.1000']);
    });

    it('includes the product and variant names for the dashboard cards', async () => {
      (prisma.subscription.findMany as jest.Mock).mockResolvedValue([
        { id: 's-1', customerId: 'cust-1', discountRate: '0.1', variant: VARIANT },
      ]);

      const [sub] = await svc.list('cust-1');

      const select = (prisma.subscription.findMany as jest.Mock).mock.calls[0][0].select;
      expect(select.variant).toEqual({
        select: {
          id: true,
          name: true,
          size: true,
          product: { select: { id: true, name: true, slug: true } },
        },
      });
      expect(sub.product).toEqual({ id: 'p-1', name: 'Wild Honey', slug: 'wild-honey' });
      expect(sub.variant).toEqual({ id: 'v-1', name: 'Wild Honey 250g', size: '250 g' });
    });
  });
});
