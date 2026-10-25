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
