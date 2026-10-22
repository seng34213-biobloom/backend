import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import { PaymentGateway } from '@prisma/client';
import type { VerifiedPaymentEvent } from './stripe.gateway';

@Injectable()
export class PayHereGateway {
  constructor(private readonly config: ConfigService) {}

  createCheckout(input: {
    orderId: string;
    amount: string;
    currency: string;
    customer: { name: string; email: string; phone: string | null };
    address: { line1: string; line2: string | null; city: string; country: string };
  }): { orderReference: string; checkoutUrl: string; params: Record<string, string> } {
    if (!input.customer.phone) {
      throw new BadRequestException('A phone number is required for PayHere checkout');
    }
    const merchantId = this.requiredConfig('PAYHERE_MERCHANT_ID');
    const merchantSecret = this.requiredConfig('PAYHERE_MERCHANT_SECRET');
    const orderReference = `payhere_${input.orderId}`;
    const amount = Number(input.amount).toFixed(2);
    const currency = input.currency.toUpperCase();
    const secretHash = md5(merchantSecret).toUpperCase();
    const hash = md5(
      `${merchantId}${orderReference}${amount}${currency}${secretHash}`,
    ).toUpperCase();
    const [firstName, ...lastNameParts] = input.customer.name.trim().split(/\s+/);
    const lastName = lastNameParts.join(' ') || firstName;

    return {
      orderReference,
      checkoutUrl:
        this.config.get<string>('PAYHERE_CHECKOUT_URL') ??
        'https://sandbox.payhere.lk/pay/checkout',
      params: {
        merchant_id: merchantId,
        return_url: this.requiredConfig('PAYHERE_RETURN_URL'),
        cancel_url: this.requiredConfig('PAYHERE_CANCEL_URL'),
        notify_url: this.requiredConfig('PAYHERE_NOTIFY_URL'),
        order_id: orderReference,
        items: `Bio Bloom order ${input.orderId}`,
        currency,
        amount,
        first_name: firstName,
        last_name: lastName,
        email: input.customer.email,
        phone: input.customer.phone ?? '',
        address: [input.address.line1, input.address.line2].filter(Boolean).join(', '),
        city: input.address.city,
        country: input.address.country,
        hash,
      },
    };
  }

  parseWebhook(payload: Record<string, string>): VerifiedPaymentEvent {
    const merchantId = this.requiredConfig('PAYHERE_MERCHANT_ID');
    const merchantSecret = this.requiredConfig('PAYHERE_MERCHANT_SECRET');
    const {
      merchant_id,
      order_id,
      payment_id,
      payhere_amount,
      payhere_currency,
      status_code,
      md5sig,
    } = payload;
    const fields = [
      merchant_id,
      order_id,
      payment_id,
      payhere_amount,
      payhere_currency,
      status_code,
      md5sig,
    ];
    if (fields.some((field) => typeof field !== 'string' || field.length === 0)) {
      throw new BadRequestException('PayHere notification is missing required string fields');
    }
    if (
      !merchant_id ||
      !order_id ||
      !payment_id ||
      !payhere_amount ||
      !payhere_currency ||
      !status_code ||
      !md5sig
    ) {
      throw new BadRequestException('PayHere notification is missing required fields');
    }
    if (merchant_id !== merchantId) {
      throw new BadRequestException('PayHere merchant id does not match');
    }
    const expected = md5(
      `${merchant_id}${order_id}${payhere_amount}${payhere_currency}${status_code}${md5(merchantSecret).toUpperCase()}`,
    ).toUpperCase();
    if (!safeEqualHex(md5sig, expected)) {
      throw new BadRequestException('PayHere notification signature mismatch');
    }

    const status = Number(status_code);
    if (status !== 2 && status !== -1 && status !== -2) {
      throw new BadRequestException(`Unhandled PayHere status code: ${status_code}`);
    }
    return {
      gateway: PaymentGateway.PAYHERE,
      gatewayPaymentId: order_id,
      type: status === 2 ? 'payment_succeeded' : 'payment_failed',
      amount: payhere_amount,
      currency: payhere_currency,
      rawPayload: payload,
    };
  }

  private requiredConfig(key: string): string {
    const value = this.config.get<string>(key);
    if (!value) throw new ServiceUnavailableException(`${key} is not configured`);
    return value;
  }
}

function md5(value: string): string {
  return createHash('md5').update(value).digest('hex');
}

function safeEqualHex(left: string, right: string): boolean {
  if (!/^[a-f\d]{32}$/i.test(left) || left.length !== right.length) return false;
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
