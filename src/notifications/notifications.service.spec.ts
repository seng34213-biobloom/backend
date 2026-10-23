import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from './mailer.service';
import { DOMAIN_EVENTS, NotificationsService } from './notifications.service';

describe('NotificationsService', () => {
  let emitter: EventEmitter2;
  let mailer: jest.Mocked<MailerService>;
  let prisma: jest.Mocked<PrismaService>;
  let service: NotificationsService;

  const config = (values: Record<string, string> = {}) =>
    ({ get: jest.fn((key: string) => values[key]) }) as unknown as ConfigService;

  const batchPayload = {
    batchId: 'b-1',
    productVariantId: 'v-1',
    batchNumber: 'B-001',
    expiryDate: '2026-10-26',
    currentQuantity: 12,
    daysUntilExpiry: 5,
  };

  beforeEach(() => {
    emitter = new EventEmitter2();
    mailer = {
      send: jest.fn().mockResolvedValue({ accepted: true, templateId: 'd-template' }),
    } as unknown as jest.Mocked<MailerService>;
    prisma = {
      order: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'order-1',
          totalAmount: '1500',
          currency: 'LKR',
          customer: { email: 'customer@example.com' },
        }),
      },
      customer: {
        findUnique: jest.fn().mockResolvedValue({ email: 'customer@example.com' }),
      },
      subscription: {
        findUnique: jest.fn().mockResolvedValue({
          nextBillingDate: new Date('2026-11-20T00:00:00Z'),
          variant: { name: '250g', product: { name: 'Wild Honey' } },
        }),
      },
      adminUser: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ email: 'ops@biobloom.lk' }, { email: 'owner@biobloom.lk' }]),
      },
    } as unknown as jest.Mocked<PrismaService>;
    service = new NotificationsService(
      emitter,
      mailer,
      prisma,
      config({
        STOREFRONT_URL: 'https://biobloom.lk/',
        SELLER_PORTAL_URL: 'https://seller.biobloom.lk',
      }),
    );
    service.onModuleInit();
  });

  describe('orders', () => {
    it('sends an order confirmation email to the customer after payment succeeds', async () => {
      await emitter.emitAsync(DOMAIN_EVENTS.ORDER_CONFIRMED, { orderId: 'order-1' });

      expect(prisma.order.findUnique).toHaveBeenCalledWith({
        where: { id: 'order-1' },
        select: {
          id: true,
          totalAmount: true,
          currency: true,
          customer: { select: { email: true } },
        },
      });
      expect(mailer.send).toHaveBeenCalledWith({
        to: 'customer@example.com',
        template: 'ORDER_CONFIRMED',
        data: {
          orderId: 'order-1',
          totalAmount: '1500.00',
          currency: 'LKR',
          orderUrl: 'https://biobloom.lk/account/orders/order-1',
        },
      });
    });

    it('skips the order email when the order no longer exists', async () => {
      (prisma.order.findUnique as jest.Mock).mockResolvedValueOnce(null);

      await emitter.emitAsync(DOMAIN_EVENTS.ORDER_CONFIRMED, { orderId: 'missing' });

      expect(mailer.send).not.toHaveBeenCalled();
    });

    it.each([
      [DOMAIN_EVENTS.ORDER_SHIPPED, 'ORDER_SHIPPED'],
      [DOMAIN_EVENTS.ORDER_DELIVERED, 'ORDER_DELIVERED'],
    ])('%s emails the customer', async (event, template) => {
      await emitter.emitAsync(event, { orderId: 'order-1', actorId: 'staff-1' });

      expect(mailer.send).toHaveBeenCalledWith({
        to: 'customer@example.com',
        template,
        data: { orderId: 'order-1', orderUrl: 'https://biobloom.lk/account/orders/order-1' },
      });
    });
  });

  describe('subscriptions', () => {
    it('emails the customer when a subscription renews', async () => {
      await emitter.emitAsync(DOMAIN_EVENTS.SUBSCRIPTION_RENEWED, {
        subscriptionId: 's-1',
        customerId: 'c-1',
        orderId: 'order-9',
        amount: '1350.00',
        currency: 'LKR',
      });

      expect(mailer.send).toHaveBeenCalledWith({
        to: 'customer@example.com',
        template: 'SUBSCRIPTION_RENEWED',
        data: {
          subscriptionId: 's-1',
          orderId: 'order-9',
          amount: '1350.00',
          currency: 'LKR',
          manageUrl: 'https://biobloom.lk/account/subscriptions',
        },
      });
    });

    it('confirms a cancellation with the product name', async () => {
      await emitter.emitAsync(DOMAIN_EVENTS.SUBSCRIPTION_CANCELLED, {
        subscriptionId: 's-1',
        customerId: 'c-1',
      });

      expect(mailer.send).toHaveBeenCalledWith({
        to: 'customer@example.com',
        template: 'SUBSCRIPTION_CANCELLED',
        data: { subscriptionId: 's-1', productName: 'Wild Honey (250g)' },
      });
    });

    it('still confirms a cancellation when the subscription row is gone', async () => {
      (prisma.subscription.findUnique as jest.Mock).mockResolvedValueOnce(null);

      await emitter.emitAsync(DOMAIN_EVENTS.SUBSCRIPTION_CANCELLED, {
        subscriptionId: 's-1',
        customerId: 'c-1',
      });

      expect(mailer.send).toHaveBeenCalledWith(
        expect.objectContaining({ data: { subscriptionId: 's-1', productName: null } }),
      );
    });

    it('tells the customer their delivery is delayed when stock is short', async () => {
      await emitter.emitAsync(DOMAIN_EVENTS.SUBSCRIPTION_STOCK_DELAYED, {
        subscriptionId: 's-1',
        customerId: 'c-1',
        productVariantId: 'v-1',
        requested: 3,
        available: 1,
      });

      expect(mailer.send).toHaveBeenCalledWith({
        to: 'customer@example.com',
        template: 'SUBSCRIPTION_STOCK_DELAYED',
        data: {
          subscriptionId: 's-1',
          productName: 'Wild Honey (250g)',
          nextBillingDate: '2026-11-20',
          requested: 3,
          available: 1,
          manageUrl: 'https://biobloom.lk/account/subscriptions',
        },
      });
    });

    it('tells the customer when the stored card is declined', async () => {
      await emitter.emitAsync(DOMAIN_EVENTS.SUBSCRIPTION_CHARGE_FAILED, {
        subscriptionId: 's-1',
        customerId: 'c-1',
        reason: 'card_declined',
      });

      expect(mailer.send).toHaveBeenCalledWith({
        to: 'customer@example.com',
        template: 'SUBSCRIPTION_CHARGE_FAILED',
        data: {
          subscriptionId: 's-1',
          productName: 'Wild Honey (250g)',
          nextBillingDate: '2026-11-20',
          reason: 'card_declined',
          manageUrl: 'https://biobloom.lk/account/subscriptions',
        },
      });
    });

    it('skips customer emails when the customer no longer exists', async () => {
      (prisma.customer.findUnique as jest.Mock).mockResolvedValue(null);

      await emitter.emitAsync(DOMAIN_EVENTS.SUBSCRIPTION_CANCELLED, {
        subscriptionId: 's-1',
        customerId: 'gone',
      });
      await emitter.emitAsync(DOMAIN_EVENTS.SUBSCRIPTION_RENEWED, {
        subscriptionId: 's-1',
        customerId: 'gone',
        orderId: 'o',
        amount: '1',
        currency: 'LKR',
      });
      await emitter.emitAsync(DOMAIN_EVENTS.REFUND_APPROVED, {
        refundRequestId: 'r-1',
        customerId: 'gone',
        orderId: 'o',
        amount: '1',
      });
      await emitter.emitAsync(DOMAIN_EVENTS.SUBSCRIPTION_STOCK_DELAYED, {
        subscriptionId: 's-1',
        customerId: 'gone',
        productVariantId: 'v-1',
        requested: 1,
        available: 0,
      });
      await emitter.emitAsync(DOMAIN_EVENTS.SUBSCRIPTION_CHARGE_FAILED, {
        subscriptionId: 's-1',
        customerId: 'gone',
        reason: 'x',
      });

      expect(mailer.send).not.toHaveBeenCalled();
    });
  });

  describe('refunds and sellers', () => {
    it('emails the customer when a refund is approved, in the order currency', async () => {
      await emitter.emitAsync(DOMAIN_EVENTS.REFUND_APPROVED, {
        refundRequestId: 'r-1',
        customerId: 'c-1',
        orderId: 'order-1',
        amount: '450.00',
      });

      expect(mailer.send).toHaveBeenCalledWith({
        to: 'customer@example.com',
        template: 'REFUND_ISSUED',
        data: { orderId: 'order-1', amount: '450.00', currency: 'LKR' },
      });
    });

    it('falls back to LKR when the refunded order is gone', async () => {
      (prisma.order.findUnique as jest.Mock).mockResolvedValueOnce(null);

      await emitter.emitAsync(DOMAIN_EVENTS.REFUND_APPROVED, {
        refundRequestId: 'r-1',
        customerId: 'c-1',
        orderId: 'gone',
        amount: '450.00',
      });

      expect(mailer.send).toHaveBeenCalledWith(
        expect.objectContaining({ data: { orderId: 'gone', amount: '450.00', currency: 'LKR' } }),
      );
    });

    it('welcomes an approved seller with a link to the seller portal', async () => {
      await emitter.emitAsync(DOMAIN_EVENTS.SELLER_APPROVED, {
        sellerId: 's-1',
        email: 'kitchen@example.com',
        businessName: 'Kitchen Amma',
        approvedByAdminId: 'a-1',
      });

      expect(mailer.send).toHaveBeenCalledWith({
        to: 'kitchen@example.com',
        template: 'SELLER_APPROVED',
        data: { businessName: 'Kitchen Amma', portalUrl: 'https://seller.biobloom.lk' },
      });
    });

    it('only logs seller applications, seller rejections and refund rejections', async () => {
      await emitter.emitAsync(DOMAIN_EVENTS.SELLER_APPLIED, {
        sellerId: 's-1',
        email: 'kitchen@example.com',
        businessName: 'Kitchen Amma',
      });
      await emitter.emitAsync(DOMAIN_EVENTS.SELLER_REJECTED, {
        sellerId: 's-1',
        email: 'kitchen@example.com',
        businessName: 'Kitchen Amma',
        rejectedByAdminId: 'a-1',
        reason: 'Incomplete documents',
      });
      await emitter.emitAsync(DOMAIN_EVENTS.REFUND_REJECTED, {
        refundRequestId: 'r-1',
        customerId: 'c-1',
        orderId: 'order-1',
        reason: 'Outside the refund window',
      });

      expect(mailer.send).not.toHaveBeenCalled();
    });
  });

  describe('batches', () => {
    it('emails every active admin once when a batch is expiring soon', async () => {
      (prisma.adminUser.findMany as jest.Mock).mockResolvedValueOnce([
        { email: 'ops@biobloom.lk' },
        { email: 'OPS@biobloom.lk' },
        { email: 'owner@biobloom.lk' },
      ]);

      await emitter.emitAsync(DOMAIN_EVENTS.BATCH_EXPIRING_SOON, batchPayload);

      expect(prisma.adminUser.findMany).toHaveBeenCalledWith({
        where: { active: true, role: 'ADMIN' },
        select: { email: true },
      });
      expect(mailer.send).toHaveBeenCalledTimes(2);
      expect(mailer.send).toHaveBeenCalledWith({
        to: 'ops@biobloom.lk',
        template: 'BATCH_EXPIRING_SOON',
        data: {
          batchNumber: 'B-001',
          productVariantId: 'v-1',
          currentQuantity: 12,
          daysUntilExpiry: 5,
        },
      });
    });

    it('sends nothing when there are no active admins', async () => {
      (prisma.adminUser.findMany as jest.Mock).mockResolvedValueOnce([]);

      await emitter.emitAsync(DOMAIN_EVENTS.BATCH_EXPIRING_SOON, batchPayload);

      expect(mailer.send).not.toHaveBeenCalled();
    });

    it('keeps going when a send is not accepted', async () => {
      mailer.send.mockResolvedValueOnce({ accepted: false, templateId: 'd-batch-expiring-soon' });

      await emitter.emitAsync(DOMAIN_EVENTS.BATCH_EXPIRING_SOON, batchPayload);

      expect(mailer.send).toHaveBeenCalledTimes(2);
    });
  });

  it('never lets a listener error escape to the emitter', async () => {
    (prisma.adminUser.findMany as jest.Mock).mockRejectedValueOnce(new Error('database down'));

    await expect(
      emitter.emitAsync(DOMAIN_EVENTS.BATCH_EXPIRING_SOON, batchPayload),
    ).resolves.toBeDefined();
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it('emit helpers publish the matching domain event', () => {
    const emit = jest.spyOn(emitter, 'emit');
    const calls: Array<[keyof NotificationsService, string, object]> = [
      ['emitSellerApplied', DOMAIN_EVENTS.SELLER_APPLIED, { sellerId: 's' }],
      ['emitSellerApproved', DOMAIN_EVENTS.SELLER_APPROVED, { sellerId: 's' }],
      ['emitSellerRejected', DOMAIN_EVENTS.SELLER_REJECTED, { sellerId: 's' }],
      ['emitOrderConfirmed', DOMAIN_EVENTS.ORDER_CONFIRMED, { orderId: 'o' }],
      ['emitOrderShipped', DOMAIN_EVENTS.ORDER_SHIPPED, { orderId: 'o' }],
      ['emitOrderDelivered', DOMAIN_EVENTS.ORDER_DELIVERED, { orderId: 'o' }],
      ['emitSubscriptionRenewed', DOMAIN_EVENTS.SUBSCRIPTION_RENEWED, { subscriptionId: 's' }],
      ['emitSubscriptionCancelled', DOMAIN_EVENTS.SUBSCRIPTION_CANCELLED, { subscriptionId: 's' }],
      [
        'emitSubscriptionStockDelayed',
        DOMAIN_EVENTS.SUBSCRIPTION_STOCK_DELAYED,
        { subscriptionId: 's' },
      ],
      [
        'emitSubscriptionChargeFailed',
        DOMAIN_EVENTS.SUBSCRIPTION_CHARGE_FAILED,
        { subscriptionId: 's' },
      ],
      ['emitRefundApproved', DOMAIN_EVENTS.REFUND_APPROVED, { refundRequestId: 'r' }],
      ['emitRefundRejected', DOMAIN_EVENTS.REFUND_REJECTED, { refundRequestId: 'r' }],
      ['emitBatchExpiringSoon', DOMAIN_EVENTS.BATCH_EXPIRING_SOON, { batchId: 'b' }],
      ['emitBatchExpired', DOMAIN_EVENTS.BATCH_EXPIRED, { batchId: 'b' }],
    ];

    for (const [method, event, payload] of calls) {
      (service[method] as (p: object) => void)(payload);
      expect(emit).toHaveBeenLastCalledWith(event, payload);
    }
  });

  it('defaults the storefront and seller portal URLs for local development', async () => {
    const localEmitter = new EventEmitter2();
    new NotificationsService(localEmitter, mailer, prisma, config()).onModuleInit();

    await localEmitter.emitAsync(DOMAIN_EVENTS.SELLER_APPROVED, {
      sellerId: 's-1',
      email: 'kitchen@example.com',
      businessName: 'Kitchen Amma',
      approvedByAdminId: 'a-1',
    });
    await localEmitter.emitAsync(DOMAIN_EVENTS.ORDER_SHIPPED, { orderId: 'order-1', actorId: 'x' });

    expect(mailer.send).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ portalUrl: 'http://localhost:3002' }),
      }),
    );
    expect(mailer.send).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ orderUrl: 'http://localhost:3000/account/orders/order-1' }),
      }),
    );
  });
});
