import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { PaymentGateway } from '@prisma/client';

export interface VerifiedPaymentEvent {
  gateway: PaymentGateway;
  gatewayPaymentId: string;
  type: 'payment_succeeded' | 'payment_failed';
  // Signed into the event, for events that carry a different id from the stored payment
  orderId?: string;
  amount?: string;
  currency?: string;
  rawPayload: unknown;
}

export interface StoredTokenChargeRequest {
  paymentId: string;
  token: string;
  amount: string;
  currency: string;
  idempotencyKey: string;
  description: string;
}

export interface StoredTokenCharge {
  succeeded: boolean;
  gatewayPaymentId?: string;
  failureReason?: string;
}

const SESSION_OUTCOMES: Record<string, VerifiedPaymentEvent['type']> = {
  'checkout.session.completed': 'payment_succeeded',
  'checkout.session.async_payment_succeeded': 'payment_succeeded',
  'checkout.session.async_payment_failed': 'payment_failed',
  'checkout.session.expired': 'payment_failed',
};

// Stripe's minimum; just past the unpaid order timeout (ADR-010)
const CHECKOUT_SESSION_MINUTES = 31;

@Injectable()
export class StripeGateway {
  constructor(private readonly config: ConfigService) {}

  /** Hosted Stripe Checkout page for one order; card details never reach us (ADR-009). */
  async createCheckoutSession(input: {
    orderId: string;
    amount: string;
    currency: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ id: string; url: string }> {
    const metadata = { orderId: input.orderId };
    const session = await this.client().checkout.sessions.create(
      {
        mode: 'payment',
        client_reference_id: input.orderId,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: input.currency.toLowerCase(),
              unit_amount: Math.round(Number(input.amount) * 100),
              product_data: { name: 'Bio Bloom order' },
            },
          },
        ],
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_SESSION_MINUTES * 60,
        metadata,
        payment_intent_data: { metadata },
      },
      { idempotencyKey: `checkout-${input.orderId}` },
    );
    if (!session.url) throw new ServiceUnavailableException('Stripe did not return a checkout URL');
    return { id: session.id, url: session.url };
  }

  parseWebhook(rawBody: Buffer, signature: string | undefined): VerifiedPaymentEvent {
    if (!signature) throw new BadRequestException('Missing Stripe-Signature header');
    const secret = this.config.get<string>('STRIPE_WEBHOOK_SECRET');
    if (!secret) throw new ServiceUnavailableException('STRIPE_WEBHOOK_SECRET is not configured');

    const stripe = this.client();
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, secret);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid Stripe webhook';
      throw new BadRequestException(`Stripe webhook signature or payload is invalid: ${message}`);
    }

    const sessionOutcome = SESSION_OUTCOMES[event.type];
    if (sessionOutcome) {
      const session = event.data.object as Stripe.Checkout.Session;
      if (event.type === 'checkout.session.completed' && session.payment_status !== 'paid') {
        throw new BadRequestException(`Stripe session is ${session.payment_status}, not paid`);
      }
      return {
        gateway: PaymentGateway.STRIPE,
        gatewayPaymentId: session.id,
        type: sessionOutcome,
        orderId: session.metadata?.orderId,
        amount: session.amount_total === null ? undefined : String(session.amount_total / 100),
        currency: session.currency ?? undefined,
        rawPayload: event,
      };
    }

    if (
      event.type !== 'payment_intent.succeeded' &&
      event.type !== 'payment_intent.payment_failed'
    ) {
      throw new BadRequestException(`Unhandled Stripe event type: ${event.type}`);
    }
    const intent = event.data.object as Stripe.PaymentIntent;
    return {
      gateway: PaymentGateway.STRIPE,
      gatewayPaymentId: intent.id,
      type: event.type === 'payment_intent.succeeded' ? 'payment_succeeded' : 'payment_failed',
      orderId: intent.metadata?.orderId,
      amount: String(
        (event.type === 'payment_intent.succeeded'
          ? (intent.amount_received ?? intent.amount)
          : intent.amount) / 100,
      ),
      currency: intent.currency,
      rawPayload: event,
    };
  }

  /**
   * Off-session charge of a saved card for a Subscribe & Save renewal. The
   * stored token is `<customer id>:<payment method id>`. A card decline comes
   * back as a failed result; any other error is thrown so the caller can retry
   * with the same idempotency key.
   */
  async chargeStoredToken(input: StoredTokenChargeRequest): Promise<StoredTokenCharge> {
    const [customer, paymentMethod] = input.token.includes(':')
      ? input.token.split(':', 2)
      : [undefined, input.token];
    try {
      const intent = await this.client().paymentIntents.create(
        {
          amount: Math.round(Number(input.amount) * 100),
          currency: input.currency.toLowerCase(),
          customer,
          payment_method: paymentMethod,
          off_session: true,
          confirm: true,
          description: input.description,
          metadata: { paymentId: input.paymentId },
        },
        { idempotencyKey: input.idempotencyKey },
      );
      if (intent.status === 'succeeded') return { succeeded: true, gatewayPaymentId: intent.id };
      return {
        succeeded: false,
        gatewayPaymentId: intent.id,
        failureReason: `payment_intent_${intent.status}`,
      };
    } catch (e) {
      const err = e as {
        type?: string;
        code?: string;
        decline_code?: string;
        payment_intent?: { id: string };
      };
      if (err.type === 'StripeCardError') {
        return {
          succeeded: false,
          gatewayPaymentId: err.payment_intent?.id,
          failureReason: err.decline_code ?? err.code ?? 'card_declined',
        };
      }
      throw e;
    }
  }

  private client(): Stripe {
    const secretKey = this.config.get<string>('STRIPE_SECRET_KEY');
    if (!secretKey) throw new ServiceUnavailableException('STRIPE_SECRET_KEY is not configured');
    return new Stripe(secretKey);
  }
}
