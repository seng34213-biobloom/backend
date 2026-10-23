import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { PaymentGateway } from '@prisma/client';

export interface VerifiedPaymentEvent {
  gateway: PaymentGateway;
  gatewayPaymentId: string;
  type: 'payment_succeeded' | 'payment_failed';
  amount?: string;
  currency?: string;
  rawPayload: unknown;
}

@Injectable()
export class StripeGateway {
  constructor(private readonly config: ConfigService) {}

  async createIntent(input: {
    orderId: string;
    amount: string;
    currency: string;
  }): Promise<{ id: string; clientSecret: string }> {
    const paymentIntent = await this.client().paymentIntents.create(
      {
        amount: Math.round(Number(input.amount) * 100),
        currency: input.currency.toLowerCase(),
        automatic_payment_methods: { enabled: true },
        metadata: { orderId: input.orderId },
      },
      { idempotencyKey: `order-${input.orderId}` },
    );
    if (!paymentIntent.client_secret) {
      throw new ServiceUnavailableException('Stripe did not return a client secret');
    }
    return { id: paymentIntent.id, clientSecret: paymentIntent.client_secret };
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
      amount: String(
        (event.type === 'payment_intent.succeeded'
          ? (intent.amount_received ?? intent.amount)
          : intent.amount) / 100,
      ),
      currency: intent.currency,
      rawPayload: event,
    };
  }

  private client(): Stripe {
    const secretKey = this.config.get<string>('STRIPE_SECRET_KEY');
    if (!secretKey) throw new ServiceUnavailableException('STRIPE_SECRET_KEY is not configured');
    return new Stripe(secretKey);
  }
}
