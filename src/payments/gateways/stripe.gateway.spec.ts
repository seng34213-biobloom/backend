import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentGateway } from '@prisma/client';
import { createHmac } from 'node:crypto';
import { StripeGateway } from './stripe.gateway';

describe('StripeGateway', () => {
  const webhookSecret = 'whsec_test_secret';
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'STRIPE_SECRET_KEY') return 'sk_test_123';
      if (key === 'STRIPE_WEBHOOK_SECRET') return webhookSecret;
      return undefined;
    }),
  } as unknown as ConfigService;

  it('verifies Stripe signatures and parses successful payment intents', () => {
    const gateway = new StripeGateway(config);
    const body = Buffer.from(
      JSON.stringify({
        id: 'evt_test_1',
        object: 'event',
        api_version: '2024-06-20',
        created: 1_700_000_000,
        data: {
          object: {
            id: 'pi_test_1',
            object: 'payment_intent',
            amount: 5000,
            amount_received: 5000,
            currency: 'lkr',
          },
        },
        livemode: false,
        pending_webhooks: 1,
        request: { id: null, idempotency_key: null },
        type: 'payment_intent.succeeded',
      }),
    );
    const timestamp = Math.floor(Date.now() / 1000);
    const digest = createHmac('sha256', webhookSecret)
      .update(`${timestamp}.${body.toString('utf8')}`)
      .digest('hex');

    expect(gateway.parseWebhook(body, `t=${timestamp},v1=${digest}`)).toMatchObject({
      gateway: PaymentGateway.STRIPE,
      gatewayPaymentId: 'pi_test_1',
      type: 'payment_succeeded',
      amount: '50',
      currency: 'lkr',
    });
  });

  it('rejects a mismatched Stripe signature', () => {
    const gateway = new StripeGateway(config);
    expect(() => gateway.parseWebhook(Buffer.from('{}'), 't=1,v1=bad')).toThrow();
  });

  describe('createCheckoutSession', () => {
    const input = {
      orderId: 'order-1',
      amount: '1500.00',
      currency: 'LKR',
      successUrl: 'https://shop.example.com/done',
      cancelUrl: 'https://shop.example.com/orders/order-1',
    };
    const withSession = (session: unknown) => {
      const gateway = new StripeGateway(config);
      const create = jest.fn().mockResolvedValue(session);
      jest
        .spyOn(gateway as unknown as { client(): unknown }, 'client')
        .mockReturnValue({ checkout: { sessions: { create } } });
      return { gateway, create };
    };

    it('creates a hosted session that carries the order on both objects', async () => {
      const { gateway, create } = withSession({ id: 'cs_1', url: 'https://stripe.test/cs_1' });

      await expect(gateway.createCheckoutSession(input)).resolves.toEqual({
        id: 'cs_1',
        url: 'https://stripe.test/cs_1',
      });

      const [params, options] = create.mock.calls[0];
      expect(params).toMatchObject({
        mode: 'payment',
        client_reference_id: 'order-1',
        metadata: { orderId: 'order-1' },
        payment_intent_data: { metadata: { orderId: 'order-1' } },
      });
      expect(params.line_items[0].price_data).toMatchObject({
        currency: 'lkr',
        unit_amount: 150000,
      });
      expect(params.expires_at - Date.now() / 1000).toBeGreaterThan(30 * 60);
      expect(options).toEqual({ idempotencyKey: 'checkout-order-1' });
    });

    it('fails when Stripe returns no page to send the customer to', async () => {
      const { gateway } = withSession({ id: 'cs_1', url: null });
      await expect(gateway.createCheckoutSession(input)).rejects.toThrow('checkout URL');
    });
  });

  describe('card setup', () => {
    const input = {
      setupId: 'setup-1',
      customer: { id: 'cust-1', email: 'ada@example.com', name: 'Ada' },
      returnUrl: 'https://shop.example/checkout?subscribe=1',
    };
    const setupSession = {
      mode: 'setup',
      status: 'complete',
      customer: 'cus_1',
      metadata: { customerId: 'cust-1' },
      setup_intent: { status: 'succeeded', payment_method: 'pm_1' },
    };
    const withClient = (client: unknown) => {
      const gateway = new StripeGateway(config);
      jest.spyOn(gateway as unknown as { client: () => unknown }, 'client').mockReturnValue(client);
      return gateway;
    };
    const retrieving = (session: unknown, setupIntents?: unknown) =>
      withClient({
        checkout: { sessions: { retrieve: jest.fn().mockResolvedValue(session) } },
        setupIntents,
      });

    it('opens a setup session that charges nothing and returns to the storefront', async () => {
      const create = jest.fn().mockResolvedValue({ id: 'cs_1', url: 'https://stripe/cs_1' });
      const customers = { create: jest.fn().mockResolvedValue({ id: 'cus_1' }) };

      await expect(
        withClient({ customers, checkout: { sessions: { create } } }).createSetupSession(input),
      ).resolves.toEqual({ id: 'cs_1', url: 'https://stripe/cs_1' });

      expect(customers.create).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'ada@example.com', name: 'Ada' }),
        { idempotencyKey: 'setup-customer-setup-1' },
      );
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'setup',
          customer: 'cus_1',
          allowed_payment_method_types: ['card'],
          success_url:
            'https://shop.example/checkout?subscribe=1&setup_session={CHECKOUT_SESSION_ID}',
          cancel_url: input.returnUrl,
          metadata: { customerId: 'cust-1', setupId: 'setup-1' },
        }),
        { idempotencyKey: 'setup-session-setup-1' },
      );
    });

    it('fails when Stripe returns no setup page', async () => {
      const gateway = withClient({
        customers: { create: jest.fn().mockResolvedValue({ id: 'cus_1' }) },
        checkout: { sessions: { create: jest.fn().mockResolvedValue({ id: 'cs_1', url: null }) } },
      });
      await expect(gateway.createSetupSession(input)).rejects.toThrow('setup URL');
    });

    it('turns a finished session into the stored token', async () => {
      await expect(retrieving(setupSession).completeSetupSession('cs_1', 'cust-1')).resolves.toBe(
        'cus_1:pm_1',
      );
    });

    it('fetches the setup intent when it was not expanded', async () => {
      const setupIntents = {
        retrieve: jest
          .fn()
          .mockResolvedValue({ status: 'succeeded', payment_method: { id: 'pm_2' } }),
      };
      await expect(
        retrieving({ ...setupSession, setup_intent: 'seti_1' }, setupIntents).completeSetupSession(
          'cs_1',
          'cust-1',
        ),
      ).resolves.toBe('cus_1:pm_2');
    });

    it("refuses another customer's session and a payment session", async () => {
      await expect(
        retrieving(setupSession).completeSetupSession('cs_1', 'cust-2'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        retrieving({ ...setupSession, mode: 'payment' }).completeSetupSession('cs_1', 'cust-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses a session the customer abandoned', async () => {
      await expect(
        retrieving({ ...setupSession, status: 'open' }).completeSetupSession('cs_1', 'cust-1'),
      ).rejects.toThrow('not been completed');
    });

    it('refuses a setup that did not succeed', async () => {
      await expect(
        retrieving({
          ...setupSession,
          setup_intent: { status: 'requires_action', payment_method: null },
        }).completeSetupSession('cs_1', 'cust-1'),
      ).rejects.toThrow('did not succeed');
    });
  });

  describe('checkout session webhooks', () => {
    const signed = (type: string, session: Record<string, unknown>) => {
      const body = Buffer.from(
        JSON.stringify({
          id: 'evt_session',
          object: 'event',
          api_version: '2024-06-20',
          created: 1_700_000_000,
          data: { object: { id: 'cs_1', object: 'checkout.session', ...session } },
          livemode: false,
          pending_webhooks: 1,
          request: { id: null, idempotency_key: null },
          type,
        }),
      );
      const timestamp = Math.floor(Date.now() / 1000);
      const digest = createHmac('sha256', webhookSecret)
        .update(`${timestamp}.${body.toString('utf8')}`)
        .digest('hex');
      return { body, signature: `t=${timestamp},v1=${digest}` };
    };
    const paid = {
      payment_status: 'paid',
      amount_total: 150000,
      currency: 'lkr',
      metadata: { orderId: 'order-1' },
    };

    it.each(['checkout.session.completed', 'checkout.session.expired'])(
      'ignores %s for a card setup',
      (type) => {
        const { body, signature } = signed(type, {
          mode: 'setup',
          payment_status: 'no_payment_required',
          amount_total: null,
          currency: null,
        });
        expect(new StripeGateway(config).parseWebhook(body, signature)).toEqual({
          type: 'ignored',
        });
      },
    );

    it('reports a paid session', () => {
      const { body, signature } = signed('checkout.session.completed', paid);

      expect(new StripeGateway(config).parseWebhook(body, signature)).toMatchObject({
        gatewayPaymentId: 'cs_1',
        type: 'payment_succeeded',
        orderId: 'order-1',
        amount: '1500',
        currency: 'lkr',
      });
    });

    it('does not treat a completed but unpaid session as paid', () => {
      const { body, signature } = signed('checkout.session.completed', {
        ...paid,
        payment_status: 'unpaid',
      });

      expect(() => new StripeGateway(config).parseWebhook(body, signature)).toThrow('not paid');
    });

    it('reports an expired session as failed', () => {
      const { body, signature } = signed('checkout.session.expired', {
        ...paid,
        payment_status: 'unpaid',
        amount_total: null,
      });

      expect(new StripeGateway(config).parseWebhook(body, signature)).toMatchObject({
        type: 'payment_failed',
        amount: undefined,
      });
    });

    it('passes the order id from a payment intent', () => {
      const { body, signature } = signed('payment_intent.succeeded', {
        id: 'pi_1',
        object: 'payment_intent',
        amount: 150000,
        amount_received: 150000,
        currency: 'lkr',
        metadata: { orderId: 'order-1' },
      });

      expect(new StripeGateway(config).parseWebhook(body, signature)).toMatchObject({
        gatewayPaymentId: 'pi_1',
        orderId: 'order-1',
      });
    });
  });

  describe('chargeStoredToken', () => {
    const request = {
      paymentId: 'payment-1',
      token: 'cus_123:pm_456',
      amount: '2050.00',
      currency: 'LKR',
      idempotencyKey: 'sub-1:2026-11-01',
      description: 'Bio Bloom Subscribe & Save 2026-11-01',
    };
    const withClient = (create: jest.Mock) => {
      const gateway = new StripeGateway(config);
      jest
        .spyOn(gateway as unknown as { client: () => unknown }, 'client')
        .mockReturnValue({ paymentIntents: { create } });
      return gateway;
    };

    it('confirms an off-session intent for the saved customer and card', async () => {
      const create = jest.fn().mockResolvedValue({ id: 'pi_1', status: 'succeeded' });

      await expect(withClient(create).chargeStoredToken(request)).resolves.toEqual({
        succeeded: true,
        gatewayPaymentId: 'pi_1',
      });
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 205000,
          currency: 'lkr',
          customer: 'cus_123',
          payment_method: 'pm_456',
          off_session: true,
          confirm: true,
        }),
        { idempotencyKey: 'sub-1:2026-11-01' },
      );
    });

    it('returns a card decline as a failed charge', async () => {
      const create = jest.fn().mockRejectedValue({
        type: 'StripeCardError',
        decline_code: 'insufficient_funds',
        payment_intent: { id: 'pi_2' },
      });

      await expect(withClient(create).chargeStoredToken(request)).resolves.toEqual({
        succeeded: false,
        gatewayPaymentId: 'pi_2',
        failureReason: 'insufficient_funds',
      });
    });

    it('throws errors that are not card declines', async () => {
      const create = jest.fn().mockRejectedValue(new Error('network down'));

      await expect(withClient(create).chargeStoredToken(request)).rejects.toThrow('network down');
    });
  });
});
