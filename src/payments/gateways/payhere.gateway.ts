import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import { PaymentGateway } from '@prisma/client';
import {
  appendQuery,
  type StoredTokenCharge,
  type StoredTokenChargeRequest,
  type VerifiedPaymentEvent,
} from './stripe.gateway';

// Part of order_id, which md5sig signs; custom fields are not signed
const SETUP_REFERENCE_PREFIX = 'setup_';

/** PayHere's answer to a card setup; `token` is absent when the card was not saved. */
export interface CardSetupEvent {
  type: 'card_setup';
  setupId: string;
  token?: string;
}

interface PayHereChargeResponse {
  status: number;
  msg?: string;
  data?: { payment_id?: number | string; status_code?: number | string; status_message?: string };
}

@Injectable()
export class PayHereGateway {
  private accessToken?: { value: string; expiresAt: number };

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
      checkoutUrl: this.requiredConfig('PAYHERE_CHECKOUT_URL'),
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

  /** Signed form for PayHere's preapproval page; the token arrives on the notify webhook. */
  createSetupCheckout(input: {
    setupId: string;
    customer: { name: string; email: string; phone: string | null };
    address: { line1: string; city: string; country: string };
    returnUrl: string;
  }): { reference: string; checkoutUrl: string; params: Record<string, string> } {
    if (!input.customer.phone) {
      throw new BadRequestException('A phone number is required for PayHere checkout');
    }
    const merchantId = this.requiredConfig('PAYHERE_MERCHANT_ID');
    const merchantSecret = this.requiredConfig('PAYHERE_MERCHANT_SECRET');
    const reference = `${SETUP_REFERENCE_PREFIX}${input.setupId}`;
    const amount = '0.00';
    const currency = 'LKR';
    const secretHash = md5(merchantSecret).toUpperCase();
    const [firstName, ...lastNameParts] = input.customer.name.trim().split(/\s+/);

    return {
      reference,
      checkoutUrl: `${this.apiUrl()}/pay/preapprove`,
      params: {
        merchant_id: merchantId,
        return_url: appendQuery(input.returnUrl, `setup_session=${reference}`),
        cancel_url: input.returnUrl,
        notify_url: this.requiredConfig('PAYHERE_NOTIFY_URL'),
        order_id: reference,
        items: 'Bio Bloom Subscribe & Save',
        currency,
        amount,
        first_name: firstName,
        last_name: lastNameParts.join(' ') || firstName,
        email: input.customer.email,
        phone: input.customer.phone,
        address: input.address.line1,
        city: input.address.city,
        country: input.address.country,
        hash: md5(`${merchantId}${reference}${amount}${currency}${secretHash}`).toUpperCase(),
      },
    };
  }

  parseWebhook(payload: Record<string, string>): VerifiedPaymentEvent | CardSetupEvent {
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
    if (order_id.startsWith(SETUP_REFERENCE_PREFIX)) {
      return {
        type: 'card_setup',
        setupId: order_id,
        token: status === 2 ? payload.customer_token || undefined : undefined,
      };
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

  /**
   * Charges a customer token saved through PayHere's preapproval flow, using
   * the Charging API. A declined charge comes back as a failed result; an
   * unreachable API or a failed OAuth call is thrown.
   */
  async chargeStoredToken(input: StoredTokenChargeRequest): Promise<StoredTokenCharge> {
    const res = await fetch(`${this.apiUrl()}/merchant/v1/payment/charge`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await this.getAccessToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'PAYMENT',
        order_id: input.paymentId,
        items: input.description,
        currency: input.currency.toUpperCase(),
        amount: Number(Number(input.amount).toFixed(2)),
        customer_token: input.token,
        custom_1: input.idempotencyKey,
      }),
    });
    if (res.status >= 500) throw new Error(`PayHere charge responded ${res.status}`);
    const body = (await res.json()) as PayHereChargeResponse;
    const gatewayPaymentId =
      body.data?.payment_id !== undefined ? String(body.data.payment_id) : undefined;
    if (body.status === 1 && Number(body.data?.status_code) === 2) {
      return { succeeded: true, gatewayPaymentId };
    }
    return {
      succeeded: false,
      gatewayPaymentId,
      failureReason: body.data?.status_message ?? body.msg ?? 'charge_declined',
    };
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now()) {
      return this.accessToken.value;
    }
    const credentials = Buffer.from(
      `${this.requiredConfig('PAYHERE_APP_ID')}:${this.requiredConfig('PAYHERE_APP_SECRET')}`,
    ).toString('base64');
    const res = await fetch(`${this.apiUrl()}/merchant/v1/oauth/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) throw new Error(`PayHere OAuth responded ${res.status}`);
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error('PayHere OAuth returned no access token');
    // Refresh a minute early so the token never expires mid-request
    this.accessToken = {
      value: json.access_token,
      expiresAt: Date.now() + Math.max(60, (json.expires_in ?? 300) - 60) * 1000,
    };
    return json.access_token;
  }

  private apiUrl(): string {
    return this.config.get<string>('PAYHERE_API_URL') ?? 'https://sandbox.payhere.lk';
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
