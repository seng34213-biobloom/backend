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
        PAYHERE_CHECKOUT_URL: 'https://sandbox.payhere.lk/pay/checkout',
        PAYHERE_RETURN_URL: 'https://shop.example/return',
        PAYHERE_CANCEL_URL: 'https://shop.example/cancel',
        PAYHERE_NOTIFY_URL: 'https://api.example/api/webhooks/payhere',
        PAYHERE_APP_ID: 'app-id',
        PAYHERE_APP_SECRET: 'app-secret',
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

  describe('chargeStoredToken', () => {
    const request = {
      paymentId: 'payment-1',
      token: 'customer-token-123',
      amount: '2050',
      currency: 'LKR',
      idempotencyKey: 'sub-1:2026-11-01',
      description: 'Bio Bloom Subscribe & Save 2026-11-01',
    };
    const json = (body: unknown, status = 200) =>
      ({ ok: status < 400, status, json: async () => body }) as Response;

    afterEach(() => jest.restoreAllMocks());

    it('gets an OAuth token once and charges the customer token', async () => {
      const fetchMock = jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(json({ access_token: 'access-1', expires_in: 3600 }))
        .mockResolvedValue(json({ status: 1, data: { payment_id: 320025, status_code: 2 } }));
      const gateway = new PayHereGateway(config);

      await expect(gateway.chargeStoredToken(request)).resolves.toEqual({
        succeeded: true,
        gatewayPaymentId: '320025',
      });
      await gateway.chargeStoredToken(request);

      expect(fetchMock).toHaveBeenCalledTimes(3);
      const [tokenUrl, tokenInit] = fetchMock.mock.calls[0];
      expect(tokenUrl).toBe('https://sandbox.payhere.lk/merchant/v1/oauth/token');
      expect((tokenInit?.headers as Record<string, string>).Authorization).toBe(
        `Basic ${Buffer.from('app-id:app-secret').toString('base64')}`,
      );
      const [chargeUrl, chargeInit] = fetchMock.mock.calls[1];
      expect(chargeUrl).toBe('https://sandbox.payhere.lk/merchant/v1/payment/charge');
      expect(JSON.parse(chargeInit?.body as string)).toEqual({
        type: 'PAYMENT',
        order_id: 'payment-1',
        items: 'Bio Bloom Subscribe & Save 2026-11-01',
        currency: 'LKR',
        amount: 2050,
        customer_token: 'customer-token-123',
        custom_1: 'sub-1:2026-11-01',
      });
    });

    it('returns a declined charge with the PayHere message', async () => {
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(json({ access_token: 'access-1', expires_in: 3600 }))
        .mockResolvedValue(
          json({
            status: 1,
            data: { payment_id: 320026, status_code: -2, status_message: 'Insufficient funds' },
          }),
        );

      await expect(new PayHereGateway(config).chargeStoredToken(request)).resolves.toEqual({
        succeeded: false,
        gatewayPaymentId: '320026',
        failureReason: 'Insufficient funds',
      });
    });

    it('throws when the Charging API is down', async () => {
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(json({ access_token: 'access-1', expires_in: 3600 }))
        .mockResolvedValue(json({}, 503));

      await expect(new PayHereGateway(config).chargeStoredToken(request)).rejects.toThrow(
        'PayHere charge responded 503',
      );
    });
  });
});
