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
  let transaction: {
    payment: { findUnique: jest.Mock };
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
        create: jest.fn().mockResolvedValue({ id: payment.id }),
        update: jest.fn().mockResolvedValue({}),
      },
      order: { findUnique: jest.fn() },
      $transaction: jest.fn((callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        callback(tx as unknown as Prisma.TransactionClient),
      ),
    } as unknown as jest.Mocked<PrismaService>;
    stripe = {
      createIntent: jest.fn(),
      parseWebhook: jest.fn(),
      chargeStoredToken: jest.fn(),
    } as unknown as jest.Mocked<StripeGateway>;
    payHere = {
      createCheckout: jest.fn(),
      parseWebhook: jest.fn(),
      chargeStoredToken: jest.fn(),
    } as unknown as jest.Mocked<PayHereGateway>;
    events = { emit: jest.fn() } as unknown as jest.Mocked<EventEmitter2>;
    const config = {
      get: jest.fn((key: string) =>
        key === 'NODE_ENV' ? (useRealGateways ? 'development' : 'test') : undefined,
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

  it('creates and persists a Stripe intent through the configured gateway', async () => {
    useRealGateways = true;
    stripe.createIntent.mockResolvedValue({
      id: 'pi_stripe_1',
      clientSecret: 'pi_stripe_1_secret',
    });

    const intent = await service.createIntent({
      orderId: 'order-1',
      amount: '1500.00',
      currency: 'LKR',
      gateway: PaymentGateway.STRIPE,
    });

    expect(stripe.createIntent).toHaveBeenCalledWith({
      orderId: 'order-1',
      amount: '1500.00',
      currency: 'LKR',
    });
    expect(intent).toMatchObject({
      gatewayPaymentId: 'pi_stripe_1',
      clientSecret: 'pi_stripe_1_secret',
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
