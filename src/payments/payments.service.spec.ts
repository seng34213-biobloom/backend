import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OrderStatus, PaymentGateway, PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PayHereGateway } from './gateways/payhere.gateway';
import { StripeGateway, VerifiedPaymentEvent } from './gateways/stripe.gateway';
import { PaymentsService } from './payments.service';

describe('PaymentsService', () => {
  let service: PaymentsService;
  let prisma: jest.Mocked<PrismaService>;
  let stripe: jest.Mocked<StripeGateway>;
  let payHere: jest.Mocked<PayHereGateway>;
  let events: jest.Mocked<EventEmitter2>;
  let useRealGateways: boolean;
  let configValues: Record<string, string>;
  let transaction: {
    payment: { findUnique: jest.Mock; findFirst: jest.Mock; update: jest.Mock };
    order: { update: jest.Mock; findUnique: jest.Mock };
    orderItem: { findMany: jest.Mock };
    productBatch: { findUnique: jest.Mock; update: jest.Mock };
  };

  const payment = {
    id: 'payment-1',
    orderId: 'order-1',
    gateway: PaymentGateway.STRIPE,
    gatewayPaymentId: 'pi_test_123',
    amount: new Prisma.Decimal('1500.00'),
    currency: 'LKR',
    status: PaymentStatus.PENDING,
  };

  beforeEach(() => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: payment.id }]),
      payment: {
        findUnique: jest.fn().mockResolvedValue(payment),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue(payment),
      },
      order: {
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({ status: OrderStatus.PENDING_PAYMENT }),
      },
      orderItem: { findMany: jest.fn().mockResolvedValue([]) },
      productBatch: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    transaction = tx;
    useRealGateways = false;
    prisma = {
      payment: {
        create: jest.fn().mockResolvedValue({ id: payment.id, status: PaymentStatus.PENDING }),
        update: jest.fn().mockResolvedValue({}),
      },
      order: { findUnique: jest.fn() },
      customer: { findUnique: jest.fn().mockResolvedValue({ phone: '0771234567' }) },
      $transaction: jest.fn((callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        callback(tx as unknown as Prisma.TransactionClient),
      ),
    } as unknown as jest.Mocked<PrismaService>;
    stripe = {
      createCheckoutSession: jest.fn(),
      parseWebhook: jest.fn(),
      chargeStoredToken: jest.fn(),
    } as unknown as jest.Mocked<StripeGateway>;
    payHere = {
      createCheckout: jest.fn(),
      parseWebhook: jest.fn(),
      chargeStoredToken: jest.fn(),
    } as unknown as jest.Mocked<PayHereGateway>;
    events = { emit: jest.fn() } as unknown as jest.Mocked<EventEmitter2>;
    configValues = { STOREFRONT_URL: 'https://shop.example.com/' };
    const config = {
      get: jest.fn((key: string) =>
        key === 'NODE_ENV' ? (useRealGateways ? 'development' : 'test') : configValues[key],
      ),
    } as unknown as ConfigService;
    service = new PaymentsService(prisma, events, config, stripe, payHere);
  });

  it('creates a pending payment row for a Stripe intent in test mode', async () => {
    const intent = await service.createIntent({
      orderId: 'order-1',
      amount: '1500.00',
      currency: 'LKR',
      gateway: PaymentGateway.STRIPE,
    });

    expect(intent).toMatchObject({
      gateway: PaymentGateway.STRIPE,
      amount: '1500.00',
      currency: 'LKR',
    });
    expect(intent.gatewayPaymentId).toMatch(/^pi_test_[a-f0-9]{24}$/);
    expect(intent.clientSecret).toContain(`${intent.gatewayPaymentId}_secret_`);
    expect(prisma.payment.create).toHaveBeenCalledWith({
      data: {
        orderId: 'order-1',
        gateway: PaymentGateway.STRIPE,
        gatewayPaymentId: intent.gatewayPaymentId,
        amount: '1500.00',
        currency: 'LKR',
        status: PaymentStatus.PENDING,
      },
    });
  });

  it('uses a pending test payment reference for PayHere intents', async () => {
    const intent = await service.createIntent({
      orderId: 'order-2',
      amount: '100.00',
      currency: 'LKR',
      gateway: PaymentGateway.PAYHERE,
    });
    expect(intent.gatewayPaymentId).toMatch(/^payhere_test_[a-f0-9]{24}$/);
  });

  it('sends test mode checkouts straight to the return page', async () => {
    const intent = await service.createIntent({
      orderId: 'order-1',
      amount: '1500.00',
      currency: 'LKR',
      gateway: PaymentGateway.STRIPE,
    });

    expect(intent).toMatchObject({
      id: payment.id,
      status: PaymentStatus.PENDING,
      checkout: {
        method: 'REDIRECT',
        url: 'https://shop.example.com/checkout/complete?orderId=order-1',
      },
    });
  });

  it('creates a hosted Stripe checkout and stores the session as the payment', async () => {
    useRealGateways = true;
    stripe.createCheckoutSession.mockResolvedValue({
      id: 'cs_test_1',
      url: 'https://checkout.stripe.com/c/cs_test_1',
    });

    const intent = await service.createIntent({
      orderId: 'order-1',
      amount: '1500.00',
      currency: 'LKR',
      gateway: PaymentGateway.STRIPE,
    });

    expect(stripe.createCheckoutSession).toHaveBeenCalledWith({
      orderId: 'order-1',
      amount: '1500.00',
      currency: 'LKR',
      successUrl: 'https://shop.example.com/checkout/complete?orderId=order-1',
      cancelUrl: 'https://shop.example.com/account/orders/order-1',
    });
    expect(intent).toMatchObject({
      id: payment.id,
      gatewayPaymentId: 'cs_test_1',
      clientSecret: null,
      checkout: { method: 'REDIRECT', url: 'https://checkout.stripe.com/c/cs_test_1' },
    });
    expect(prisma.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ gatewayPaymentId: 'cs_test_1' }),
      }),
    );
  });

  it('turns the PayHere form into a form post for the storefront', async () => {
    useRealGateways = true;
    (prisma.order.findUnique as jest.Mock).mockResolvedValue({
      customer: { name: 'Nimal', email: 'n@example.com', phone: '0771234567' },
      shippingAddress: { line1: '1 Road', line2: null, city: 'Colombo', country: 'LK' },
    });
    payHere.createCheckout.mockReturnValue({
      orderReference: 'payhere_order-1',
      checkoutUrl: 'https://sandbox.payhere.lk/pay/checkout',
      params: { merchant_id: 'm1' },
    });

    const intent = await service.createIntent({
      orderId: 'order-1',
      amount: '1500.00',
      currency: 'LKR',
      gateway: PaymentGateway.PAYHERE,
    });

    expect(intent.checkout).toEqual({
      method: 'FORM_POST',
      url: 'https://sandbox.payhere.lk/pay/checkout',
      fields: { merchant_id: 'm1' },
    });
  });

  describe('assertCheckoutAvailable', () => {
    beforeEach(() => {
      useRealGateways = true;
    });

    it('needs nothing in test mode', async () => {
      useRealGateways = false;
      await expect(
        service.assertCheckoutAvailable(PaymentGateway.PAYHERE, 'customer-1'),
      ).resolves.toBeUndefined();
    });

    it('refuses Stripe without a secret key', async () => {
      await expect(
        service.assertCheckoutAvailable(PaymentGateway.STRIPE, 'customer-1'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      configValues.STRIPE_SECRET_KEY = 'sk_test_123';
      await expect(
        service.assertCheckoutAvailable(PaymentGateway.STRIPE, 'customer-1'),
      ).resolves.toBeUndefined();
    });

    it('refuses PayHere until a merchant is configured', async () => {
      await expect(
        service.assertCheckoutAvailable(PaymentGateway.PAYHERE, 'customer-1'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('needs a phone number for PayHere', async () => {
      configValues.PAYHERE_MERCHANT_ID = 'm1';
      configValues.PAYHERE_MERCHANT_SECRET = 'secret';
      await expect(
        service.assertCheckoutAvailable(PaymentGateway.PAYHERE, 'customer-1'),
      ).resolves.toBeUndefined();

      (prisma.customer.findUnique as jest.Mock).mockResolvedValue({ phone: null });
      await expect(
        service.assertCheckoutAvailable(PaymentGateway.PAYHERE, 'customer-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('hosted checkout events carrying a different id', () => {
    const intentEvent = (type: VerifiedPaymentEvent['type']): VerifiedPaymentEvent => ({
      gateway: PaymentGateway.STRIPE,
      gatewayPaymentId: 'pi_from_session',
      type,
      orderId: 'order-1',
      amount: '1500',
      currency: 'lkr',
      rawPayload: { id: 'evt-pi' },
    });

    beforeEach(() => {
      transaction.payment.findUnique.mockResolvedValueOnce(null);
      transaction.payment.findFirst.mockResolvedValue(payment);
    });

    it('settles the order from a signed payment intent success', async () => {
      stripe.parseWebhook.mockReturnValue(intentEvent('payment_succeeded'));

      await expect(service.handleStripeWebhook(Buffer.from('{}'), 'sig')).resolves.toMatchObject({
        status: 'applied',
        paymentStatus: PaymentStatus.PAID,
      });
      expect(transaction.payment.findFirst).toHaveBeenCalledWith({
        where: { orderId: 'order-1', gateway: PaymentGateway.STRIPE },
      });
    });

    it('leaves the order open when a card is declined on the hosted page', async () => {
      stripe.parseWebhook.mockReturnValue(intentEvent('payment_failed'));

      await expect(service.handleStripeWebhook(Buffer.from('{}'), 'sig')).resolves.toMatchObject({
        status: 'duplicate',
        paymentStatus: PaymentStatus.PENDING,
      });
      expect(transaction.order.update).not.toHaveBeenCalled();
      expect(transaction.payment.update).not.toHaveBeenCalled();
    });
  });

  it('marks an order paid once and emits its confirmation event', async () => {
    const event: VerifiedPaymentEvent = {
      gateway: PaymentGateway.STRIPE,
      gatewayPaymentId: payment.gatewayPaymentId,
      type: 'payment_succeeded',
      amount: '1500',
      currency: 'lkr',
      rawPayload: { id: 'evt-1' },
    };
    stripe.parseWebhook.mockReturnValue(event);

    await expect(service.handleStripeWebhook(Buffer.from('{}'), 'signature')).resolves.toEqual({
      status: 'applied',
      orderId: 'order-1',
      paymentStatus: PaymentStatus.PAID,
    });
    expect(events.emit).toHaveBeenCalledWith('order.confirmed', { orderId: 'order-1' });
  });

  it('refunds a payment that succeeds after its order was cancelled', async () => {
    const event: VerifiedPaymentEvent = {
      gateway: PaymentGateway.STRIPE,
      gatewayPaymentId: payment.gatewayPaymentId,
      type: 'payment_succeeded',
      amount: '1500',
      currency: 'LKR',
      rawPayload: { id: 'evt-late' },
    };
    stripe.parseWebhook.mockReturnValue(event);
    transaction.payment.findUnique
      .mockResolvedValueOnce(payment)
      .mockResolvedValueOnce({ ...payment, status: PaymentStatus.FAILED });
    transaction.order.findUnique.mockResolvedValue({ status: OrderStatus.CANCELLED });

    const result = await service.handleStripeWebhook(Buffer.from('{}'), 'signature');

    expect(result).toEqual({
      status: 'refunded',
      orderId: 'order-1',
      paymentStatus: PaymentStatus.REFUNDED,
    });
    expect(transaction.order.update).not.toHaveBeenCalled();
    expect(prisma.payment.update).toHaveBeenCalledWith({
      where: { id: payment.id },
      data: expect.objectContaining({
        status: PaymentStatus.REFUNDED,
        rawPayload: expect.objectContaining({ refundId: expect.stringMatching(/^re_test_/) }),
      }),
    });
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('does not apply a repeated webhook event', async () => {
    const event: VerifiedPaymentEvent = {
      gateway: PaymentGateway.STRIPE,
      gatewayPaymentId: payment.gatewayPaymentId,
      type: 'payment_succeeded',
      amount: '1500',
      currency: 'LKR',
      rawPayload: { id: 'evt-1' },
    };
    stripe.parseWebhook.mockReturnValue(event);
    transaction.payment.findUnique
      .mockResolvedValueOnce(payment)
      .mockResolvedValueOnce({ ...payment, status: PaymentStatus.PAID });

    const result = await service.handleStripeWebhook(Buffer.from('{}'), 'signature');

    expect(result).toEqual({
      status: 'duplicate',
      orderId: 'order-1',
      paymentStatus: PaymentStatus.PAID,
    });
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('rejects a webhook with an amount different from the recorded payment', async () => {
    stripe.parseWebhook.mockReturnValue({
      gateway: PaymentGateway.STRIPE,
      gatewayPaymentId: payment.gatewayPaymentId,
      type: 'payment_succeeded',
      amount: '1.00',
      currency: 'LKR',
      rawPayload: {},
    });

    await expect(service.handleStripeWebhook(Buffer.from('{}'), 'signature')).rejects.toThrow(
      'Webhook amount does not match the payment',
    );
  });

  it('cancels failed orders and restores inventory reserved at checkout', async () => {
    const event: VerifiedPaymentEvent = {
      gateway: PaymentGateway.STRIPE,
      gatewayPaymentId: payment.gatewayPaymentId,
      type: 'payment_failed',
      amount: '1500',
      currency: 'LKR',
      rawPayload: { id: 'evt-failed' },
    };
    stripe.parseWebhook.mockReturnValue(event);
    transaction.orderItem.findMany.mockResolvedValue([{ batchId: 'batch-1', quantity: 2 }]);
    transaction.productBatch.findUnique.mockResolvedValue({
      id: 'batch-1',
      status: 'DEPLETED',
    });

    await expect(service.handleStripeWebhook(Buffer.from('{}'), 'signature')).resolves.toEqual({
      status: 'applied',
      orderId: 'order-1',
      paymentStatus: PaymentStatus.FAILED,
    });
    expect(transaction.order.update).toHaveBeenCalledWith({
      where: { id: 'order-1' },
      data: expect.objectContaining({
        paymentStatus: PaymentStatus.FAILED,
        status: 'CANCELLED',
      }),
    });
    expect(transaction.productBatch.update).toHaveBeenCalledWith({
      where: { id: 'batch-1' },
      data: {
        currentQuantity: { increment: 2 },
        status: 'ACTIVE',
      },
    });
    expect(events.emit).not.toHaveBeenCalled();
  });

  describe('chargeStoredToken', () => {
    const charge = {
      paymentId: 'payment-9',
      gateway: PaymentGateway.STRIPE,
      token: 'cus_1:pm_1',
      amount: '2050.00',
      currency: 'LKR',
      idempotencyKey: 'sub-1:2026-11-01',
      description: 'Bio Bloom Subscribe & Save 2026-11-01',
    };

    it('approves a stored token in test mode and declines one marked to fail', async () => {
      await expect(service.chargeStoredToken(charge)).resolves.toEqual({
        succeeded: true,
        gatewayPaymentId: expect.stringMatching(/^pi_test_[a-f0-9]{24}$/),
      });
      await expect(
        service.chargeStoredToken({
          ...charge,
          gateway: PaymentGateway.PAYHERE,
          token: 'tok_will_fail',
        }),
      ).resolves.toEqual({
        succeeded: false,
        gatewayPaymentId: expect.stringMatching(/^payhere_test_/),
        failureReason: 'card_declined',
      });
      expect(stripe.chargeStoredToken).not.toHaveBeenCalled();
    });

    it('charges through the matching gateway outside test mode', async () => {
      useRealGateways = true;
      stripe.chargeStoredToken.mockResolvedValue({ succeeded: true, gatewayPaymentId: 'pi_1' });
      payHere.chargeStoredToken.mockResolvedValue({
        succeeded: false,
        failureReason: 'Insufficient funds',
      });

      await expect(service.chargeStoredToken(charge)).resolves.toEqual({
        succeeded: true,
        gatewayPaymentId: 'pi_1',
      });
      expect(stripe.chargeStoredToken).toHaveBeenCalledWith(charge);
      await expect(
        service.chargeStoredToken({ ...charge, gateway: PaymentGateway.PAYHERE }),
      ).resolves.toEqual({ succeeded: false, failureReason: 'Insufficient funds' });
    });

    it('returns a gateway error instead of throwing', async () => {
      useRealGateways = true;
      stripe.chargeStoredToken.mockRejectedValue(new Error('socket hang up'));

      await expect(service.chargeStoredToken(charge)).resolves.toEqual({
        succeeded: false,
        failureReason: 'gateway_error',
      });
    });
  });
});
