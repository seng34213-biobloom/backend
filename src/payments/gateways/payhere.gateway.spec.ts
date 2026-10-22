import { ConfigService } from '@nestjs/config';
import { PaymentGateway } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PayHereGateway } from './payhere.gateway';

describe('PayHereGateway', () => {
  const merchantId = '1234567';
  const merchantSecret = 'merchant_secret';
  const config = {
    get: jest.fn((key: string) => {
      const values: Record<string, string> = {
        PAYHERE_MERCHANT_ID: merchantId,
        PAYHERE_MERCHANT_SECRET: merchantSecret,
        PAYHERE_RETURN_URL: 'https://shop.example/return',
        PAYHERE_CANCEL_URL: 'https://shop.example/cancel',
        PAYHERE_NOTIFY_URL: 'https://api.example/api/webhooks/payhere',
      };
      return values[key];
    }),
  } as unknown as ConfigService;

  it('builds a signed sandbox checkout form', () => {
    const checkout = new PayHereGateway(config).createCheckout({
      orderId: 'order-1',
      amount: '1500.00',
      currency: 'LKR',
      customer: {
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        phone: '0771234567',
      },
      address: {
        line1: '1 Main Road',
        line2: null,
        city: 'Colombo',
        country: 'LK',
      },
    });

    expect(checkout.checkoutUrl).toBe('https://sandbox.payhere.lk/pay/checkout');
    expect(checkout.params).toMatchObject({
      merchant_id: merchantId,
      order_id: 'payhere_order-1',
      amount: '1500.00',
      currency: 'LKR',
      first_name: 'Ada',
      last_name: 'Lovelace',
    });
    const secretHash = createHash('md5').update(merchantSecret).digest('hex').toUpperCase();
    const expectedHash = createHash('md5')
      .update(`${merchantId}payhere_order-11500.00LKR${secretHash}`)
      .digest('hex')
      .toUpperCase();
    expect(checkout.params.hash).toBe(expectedHash);
  });

  it('verifies PayHere notification signatures and maps payment status', () => {
    const gateway = new PayHereGateway(config);
    const input = {
      merchant_id: merchantId,
      order_id: 'payhere_order-1',
      payment_id: 'payment-1',
      payhere_amount: '1500.00',
      payhere_currency: 'LKR',
      status_code: '2',
    };
    const secretHash = createHash('md5').update(merchantSecret).digest('hex').toUpperCase();
    const md5sig = createHash('md5')
      .update(
        `${input.merchant_id}${input.order_id}${input.payhere_amount}${input.payhere_currency}${input.status_code}${secretHash}`,
      )
      .digest('hex')
      .toUpperCase();

    expect(gateway.parseWebhook({ ...input, md5sig })).toMatchObject({
      gateway: PaymentGateway.PAYHERE,
      gatewayPaymentId: input.order_id,
      type: 'payment_succeeded',
      amount: input.payhere_amount,
      currency: input.payhere_currency,
    });
  });

  it('rejects a tampered PayHere notification', () => {
    expect(() =>
      new PayHereGateway(config).parseWebhook({
        merchant_id: merchantId,
        order_id: 'payhere_order-1',
        payment_id: 'payment-1',
        payhere_amount: '1500.00',
        payhere_currency: 'LKR',
        status_code: '1',
        md5sig: 'bad',
      }),
    ).toThrow('PayHere notification signature mismatch');
  });

  it.each(['-1', '-2'])('treats PayHere status %s as a failed payment', (status_code) => {
    const gateway = new PayHereGateway(config);
    const input = {
      merchant_id: merchantId,
      order_id: 'payhere_order-1',
      payment_id: 'payment-1',
      payhere_amount: '1500.00',
      payhere_currency: 'LKR',
      status_code,
    };
    const secretHash = createHash('md5').update(merchantSecret).digest('hex').toUpperCase();
    const md5sig = createHash('md5')
      .update(
        `${input.merchant_id}${input.order_id}${input.payhere_amount}${input.payhere_currency}${input.status_code}${secretHash}`,
      )
      .digest('hex')
      .toUpperCase();

    expect(gateway.parseWebhook({ ...input, md5sig }).type).toBe('payment_failed');
  });
});
