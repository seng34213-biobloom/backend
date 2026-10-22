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
});
