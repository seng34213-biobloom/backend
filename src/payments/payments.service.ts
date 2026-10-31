import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OrderStatus, PaymentGateway, PaymentStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { CardSetupEvent, PayHereGateway } from './gateways/payhere.gateway';
import { StoredTokenCharge, StripeGateway, VerifiedPaymentEvent } from './gateways/stripe.gateway';

/** How the storefront sends the customer to the gateway's hosted page. */
export type PaymentCheckout =
  | { method: 'REDIRECT'; url: string }
  | { method: 'FORM_POST'; url: string; fields: Record<string, string> };

export interface PaymentIntent {
  id: string;
  status: PaymentStatus;
  gateway: PaymentGateway;
  gatewayPaymentId: string;
  clientSecret: string | null;
  checkout: PaymentCheckout;
  amount: string;
  currency: string;
}

/** A card setup in progress. PayHere fills in the result through its webhook. */
interface PaymentSetup {
  customerId: string;
  gateway: PaymentGateway;
  token?: string;
  failed?: boolean;
}

// Outlives the gateway's hosted page, so a slow customer can still come back
const PAYMENT_SETUP_TTL_SECONDS = 2 * 60 * 60;

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly config: ConfigService,
    private readonly stripe: StripeGateway,
    private readonly payHere: PayHereGateway,
    private readonly redis: RedisService,
  ) {}

  async refundCharge(input: {
    gatewayPaymentId: string;
    amount: string;
    currency: string;
    gateway: PaymentGateway;
  }): Promise<{ succeeded: boolean; refundId: string; failureReason?: string }> {
    this.assertWebhookSecret(input.gateway);
    if (Number(input.amount) <= 0) {
      return { succeeded: false, refundId: '', failureReason: 'Refund amount must be positive' };
    }
    const succeeded = !input.gatewayPaymentId.toLowerCase().includes('decline');
    const suffix = randomUUID().replace(/-/g, '').slice(0, 20);
    const refundId =
      input.gateway === PaymentGateway.STRIPE ? `re_test_${suffix}` : `payhere_refund_${suffix}`;
    return {
      succeeded,
      refundId,
      ...(succeeded ? {} : { failureReason: 'gateway_refund_declined' }),
    };
  }

  /**
   * SDS §5.4 — charges a subscription's stored token off-session for a
   * Subscribe & Save renewal. A decline or a gateway error comes back as
   * `succeeded: false` with a reason and is never thrown, so one bad token
   * cannot stop a billing run. In tests a token containing "fail" or
   * "decline" is declined.
   */
  async chargeStoredToken(input: {
    paymentId: string;
    gateway: PaymentGateway;
    token: string;
    amount: string;
    currency: string;
    idempotencyKey: string;
    description: string;
  }): Promise<StoredTokenCharge> {
    if (this.config.get<string>('NODE_ENV') === 'test') {
      const suffix = randomUUID().replace(/-/g, '').slice(0, 24);
      const gatewayPaymentId =
        input.gateway === PaymentGateway.STRIPE ? `pi_test_${suffix}` : `payhere_test_${suffix}`;
      return /fail|decline/i.test(input.token)
        ? { succeeded: false, gatewayPaymentId, failureReason: 'card_declined' }
        : { succeeded: true, gatewayPaymentId };
    }
    try {
      return input.gateway === PaymentGateway.STRIPE
        ? await this.stripe.chargeStoredToken(input)
        : await this.payHere.chargeStoredToken(input);
    } catch (e) {
      this.logger.error(`Stored-token charge ${input.paymentId} failed: ${(e as Error).message}`);
      return { succeeded: false, failureReason: 'gateway_error' };
    }
  }

  /**
   * Called before checkout commits, so a gateway that cannot take the payment
   * fails while the cart and stock are still untouched.
   */
  async assertCheckoutAvailable(gateway: PaymentGateway, customerId: string): Promise<void> {
    if (this.config.get<string>('NODE_ENV') === 'test') return;
    this.assertWebhookSecret(gateway);
    if (gateway === PaymentGateway.STRIPE) {
      if (!this.config.get<string>('STRIPE_SECRET_KEY')) {
        throw new ServiceUnavailableException('Card payment is not available right now');
      }
      return;
    }
    if (
      !this.config.get<string>('PAYHERE_MERCHANT_ID') ||
      !this.config.get<string>('PAYHERE_MERCHANT_SECRET')
    ) {
      throw new ServiceUnavailableException(
        'PayHere is not available right now; please choose another payment method',
      );
    }
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { phone: true },
    });
    if (!customer?.phone) {
      throw new BadRequestException('A phone number is required for PayHere checkout');
    }
  }

  private storefrontUrl(path: string): string {
    const base = this.config.get<string>('STOREFRONT_URL') ?? 'http://localhost:3000';
    return `${base.replace(/\/$/, '')}${path}`;
  }

  /**
   * Starts saving a card for Subscribe & Save (ADR-009). Returns the hosted
   * gateway page, or in tests a fake token straight away (ADR-011).
   */
  async startSetup(
    customerId: string,
    gateway: PaymentGateway,
    returnUrl: string,
  ): Promise<{ paymentToken: string } | { sessionId: string; checkout: PaymentCheckout }> {
    this.assertStorefrontUrl(returnUrl);
    await this.assertCheckoutAvailable(gateway, customerId);
    const setupId = randomUUID();
    if (this.config.get<string>('NODE_ENV') === 'test') {
      const suffix = setupId.replace(/-/g, '');
      return {
        paymentToken:
          gateway === PaymentGateway.STRIPE
            ? `cus_test_${suffix}:pm_test_${suffix}`
            : `payhere_token_${suffix}`,
      };
    }

    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      include: { addresses: { orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }], take: 1 } },
    });
    if (!customer) throw new NotFoundException(`Customer ${customerId} not found`);

    let sessionId: string;
    let checkout: PaymentCheckout;
    if (gateway === PaymentGateway.STRIPE) {
      const session = await this.stripe.createSetupSession({ setupId, customer, returnUrl });
      sessionId = session.id;
      checkout = { method: 'REDIRECT', url: session.url };
    } else {
      const [address] = customer.addresses;
      if (!address) throw new BadRequestException('An address is required for PayHere checkout');
      const form = this.payHere.createSetupCheckout({ setupId, customer, address, returnUrl });
      sessionId = form.reference;
      checkout = { method: 'FORM_POST', url: form.checkoutUrl, fields: form.params };
    }
    await this.saveSetup(sessionId, { customerId, gateway });
    return { sessionId, checkout };
  }

  /** Hands over the saved token once; a reloaded return page cannot start a second subscription. */
  async completeSetup(
    customerId: string,
    gateway: PaymentGateway,
    sessionId: string,
  ): Promise<{ paymentToken: string }> {
    const raw = await this.redis.getClient().get(this.setupKey(sessionId));
    const setup = raw ? (JSON.parse(raw) as PaymentSetup) : null;
    if (!setup || setup.customerId !== customerId || setup.gateway !== gateway) {
      throw new NotFoundException('Card setup not found or expired');
    }
    if (setup.failed) {
      throw new BadRequestException('The card could not be saved. Please try again.');
    }
    const paymentToken =
      gateway === PaymentGateway.STRIPE
        ? await this.stripe.completeSetupSession(sessionId, customerId)
        : setup.token;
    if (!paymentToken) {
      throw new ConflictException('PayHere has not confirmed the card yet. Try again shortly.');
    }
    if ((await this.redis.getClient().del(this.setupKey(sessionId))) === 0) {
      throw new NotFoundException('Card setup not found or expired');
    }
    return { paymentToken };
  }

  private setupKey(sessionId: string): string {
    return `payments:setup:${sessionId}`;
  }

  private async saveSetup(sessionId: string, setup: PaymentSetup): Promise<void> {
    await this.redis
      .getClient()
      .set(this.setupKey(sessionId), JSON.stringify(setup), 'EX', PAYMENT_SETUP_TTL_SECONDS);
  }

  private async recordCardSetup(event: CardSetupEvent): Promise<{ status: 'applied' | 'ignored' }> {
    const raw = await this.redis.getClient().get(this.setupKey(event.setupId));
    if (!raw) return { status: 'ignored' };
    await this.saveSetup(event.setupId, {
      ...(JSON.parse(raw) as PaymentSetup),
      token: event.token,
      failed: !event.token,
    });
    return { status: 'applied' };
  }

  // The gateway sends the customer here afterwards, so it must stay on the storefront
  private assertStorefrontUrl(url: string): void {
    const storefront = new URL(this.storefrontUrl('/')).origin;
    if (!URL.canParse(url) || new URL(url).origin !== storefront) {
      throw new BadRequestException('returnUrl must be a storefront URL');
    }
  }

  async createIntent(input: {
    orderId: string;
    amount: string;
    currency: string;
    gateway: PaymentGateway;
  }): Promise<PaymentIntent> {
    this.assertWebhookSecret(input.gateway);
    const successUrl = this.storefrontUrl(`/checkout/complete?orderId=${input.orderId}`);
    let intent: Omit<PaymentIntent, 'id' | 'status'>;

    if (this.config.get<string>('NODE_ENV') === 'test') {
      const suffix = randomUUID().replace(/-/g, '').slice(0, 24);
      const gatewayPaymentId =
        input.gateway === PaymentGateway.STRIPE ? `pi_test_${suffix}` : `payhere_test_${suffix}`;
      intent = {
        gateway: input.gateway,
        gatewayPaymentId,
        clientSecret: `${gatewayPaymentId}_secret_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
        checkout: { method: 'REDIRECT', url: successUrl },
        amount: input.amount,
        currency: input.currency,
      };
    } else if (input.gateway === PaymentGateway.STRIPE) {
      const session = await this.stripe.createCheckoutSession({
        orderId: input.orderId,
        amount: input.amount,
        currency: input.currency,
        successUrl,
        cancelUrl: this.storefrontUrl(`/account/orders/${input.orderId}`),
      });
      intent = {
        gateway: input.gateway,
        gatewayPaymentId: session.id,
        clientSecret: null,
        checkout: { method: 'REDIRECT', url: session.url },
        amount: input.amount,
        currency: input.currency,
      };
    } else {
      const order = await this.prisma.order.findUnique({
        where: { id: input.orderId },
        include: { customer: true, shippingAddress: true },
      });
      if (!order) throw new NotFoundException(`Order ${input.orderId} not found`);
      const checkout = this.payHere.createCheckout({
        orderId: input.orderId,
        amount: input.amount,
        currency: input.currency,
        customer: order.customer,
        address: order.shippingAddress,
      });
      intent = {
        gateway: input.gateway,
        gatewayPaymentId: checkout.orderReference,
        clientSecret: null,
        checkout: { method: 'FORM_POST', url: checkout.checkoutUrl, fields: checkout.params },
        amount: input.amount,
        currency: input.currency,
      };
    }

    const payment = await this.prisma.payment.create({
      data: {
        orderId: input.orderId,
        gateway: input.gateway,
        gatewayPaymentId: intent.gatewayPaymentId,
        amount: input.amount,
        currency: input.currency,
        status: PaymentStatus.PENDING,
      },
    });
    this.logger.log(`Payment intent ${intent.gatewayPaymentId} created for order=${input.orderId}`);
    return { ...intent, id: payment.id, status: payment.status };
  }

  private assertWebhookSecret(gateway: PaymentGateway): void {
    if (this.config.get<string>('NODE_ENV') !== 'production') return;
    const secret =
      gateway === PaymentGateway.STRIPE
        ? this.config.get<string>('STRIPE_WEBHOOK_SECRET')
        : this.config.get<string>('PAYHERE_MERCHANT_SECRET');
    const name =
      gateway === PaymentGateway.STRIPE ? 'STRIPE_WEBHOOK_SECRET' : 'PAYHERE_MERCHANT_SECRET';
    if (!secret) {
      throw new ServiceUnavailableException(
        `${name} is required for production payment operations`,
      );
    }
  }

  async handleStripeWebhook(rawBody: Buffer, signature: string | undefined) {
    const event = this.stripe.parseWebhook(rawBody, signature);
    return event.type === 'ignored' ? { status: event.type } : this.applyWebhookEvent(event);
  }

  async handlePayHereWebhook(payload: Record<string, string>) {
    const event = this.payHere.parseWebhook(payload);
    return event.type === 'card_setup'
      ? this.recordCardSetup(event)
      : this.applyWebhookEvent(event);
  }

  private async applyWebhookEvent(event: VerifiedPaymentEvent): Promise<{
    status: 'applied' | 'duplicate' | 'refunded';
    orderId: string;
    paymentStatus: PaymentStatus;
  }> {
    const result = await this.prisma.$transaction(async (tx) => {
      const direct = await tx.payment.findUnique({
        where: { gatewayPaymentId: event.gatewayPaymentId },
      });
      // Stripe also reports a hosted checkout through its payment intent, whose id we never
      // stored. A declined card can still be retried on that page, so only a success counts.
      const found =
        direct ??
        (event.orderId
          ? await tx.payment.findFirst({
              where: { orderId: event.orderId, gateway: event.gateway },
            })
          : null);
      if (found && !direct && event.type === 'payment_failed') {
        return {
          status: 'duplicate' as const,
          orderId: found.orderId ?? '',
          paymentStatus: found.status,
        };
      }
      if (!found || found.gateway !== event.gateway) {
        throw new NotFoundException(
          `No ${event.gateway} payment for gatewayPaymentId ${event.gatewayPaymentId}`,
        );
      }

      await tx.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`SELECT id FROM payment WHERE id = ${found.id}::uuid FOR UPDATE`,
      );
      const payment = await tx.payment.findUnique({ where: { id: found.id } });
      if (!payment) {
        throw new NotFoundException(`Payment ${found.id} not found`);
      }
      // A payment that succeeds after its order was cancelled, for example by
      // the stale-order job, is refunded instead of reopening the order
      if (
        event.type === 'payment_succeeded' &&
        payment.orderId &&
        payment.status !== PaymentStatus.PAID &&
        payment.status !== PaymentStatus.REFUNDED
      ) {
        const order = await tx.order.findUnique({
          where: { id: payment.orderId },
          select: { status: true },
        });
        if (order?.status === OrderStatus.CANCELLED) {
          return {
            status: 'refund' as const,
            orderId: payment.orderId,
            paymentStatus: payment.status,
            payment,
          };
        }
      }
      if (payment.status !== PaymentStatus.PENDING) {
        return {
          status: 'duplicate' as const,
          orderId: payment.orderId ?? '',
          paymentStatus: payment.status,
        };
      }

      if (event.amount !== undefined && cents(event.amount) !== cents(payment.amount.toString())) {
        throw new BadRequestException('Webhook amount does not match the payment');
      }
      if (
        event.currency !== undefined &&
        event.currency.toUpperCase() !== payment.currency.toUpperCase()
      ) {
        throw new BadRequestException('Webhook currency does not match the payment');
      }

      const succeeded = event.type === 'payment_succeeded';
      const nextPaymentStatus = succeeded ? PaymentStatus.PAID : PaymentStatus.FAILED;
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: nextPaymentStatus,
          processedAt: new Date(),
          rawPayload: JSON.parse(JSON.stringify(event.rawPayload)) as Prisma.InputJsonValue,
        },
      });

      if (payment.orderId) {
        await tx.order.update({
          where: { id: payment.orderId },
          data: {
            paymentStatus: nextPaymentStatus,
            status: succeeded ? OrderStatus.PAID : OrderStatus.CANCELLED,
            ...(!succeeded ? { cancelledAt: new Date() } : {}),
          },
        });

        if (!succeeded) {
          const items = await tx.orderItem.findMany({
            where: { orderId: payment.orderId },
            select: { batchId: true, quantity: true },
          });
          for (const item of items) {
            const batch = await tx.productBatch.findUnique({ where: { id: item.batchId } });
            if (!batch) {
              throw new NotFoundException(`Inventory batch ${item.batchId} not found for restock`);
            }
            await tx.productBatch.update({
              where: { id: batch.id },
              data: {
                currentQuantity: { increment: item.quantity },
                ...(batch.status === 'DEPLETED' ? { status: 'ACTIVE' } : {}),
              },
            });
          }
        }
      }

      return {
        status: 'applied' as const,
        orderId: payment.orderId ?? '',
        paymentStatus: nextPaymentStatus,
      };
    });

    if (result.status === 'refund') {
      return this.refundLatePayment(event, result.payment);
    }

    if (
      result.status === 'applied' &&
      result.paymentStatus === PaymentStatus.PAID &&
      result.orderId
    ) {
      this.events.emit('order.confirmed', { orderId: result.orderId });
    }
    this.logger.log(
      `Webhook ${result.status}: ${event.gatewayPaymentId} -> ${result.paymentStatus} (order ${result.orderId})`,
    );
    return result;
  }

  private async refundLatePayment(
    event: VerifiedPaymentEvent,
    payment: { id: string; orderId: string | null; amount: Prisma.Decimal; currency: string },
  ): Promise<{ status: 'refunded'; orderId: string; paymentStatus: PaymentStatus }> {
    const refund = await this.refundCharge({
      gatewayPaymentId: event.gatewayPaymentId,
      amount: payment.amount.toFixed(2),
      currency: payment.currency,
      gateway: event.gateway,
    });
    // PAID with a failed refund leaves the row for a manual refund
    const paymentStatus = refund.succeeded ? PaymentStatus.REFUNDED : PaymentStatus.PAID;
    await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: paymentStatus,
        processedAt: new Date(),
        rawPayload: {
          lateSuccess: JSON.parse(JSON.stringify(event.rawPayload)) as Prisma.InputJsonValue,
          refundId: refund.refundId || null,
          refundFailureReason: refund.failureReason ?? null,
        },
      },
    });
    if (refund.succeeded) {
      this.logger.warn(
        `Refunded ${event.gatewayPaymentId}: paid after order ${payment.orderId} was cancelled`,
      );
    } else {
      this.logger.error(
        `Refund of ${event.gatewayPaymentId} for cancelled order ${payment.orderId} failed: ${refund.failureReason}`,
      );
    }
    return { status: 'refunded', orderId: payment.orderId ?? '', paymentStatus };
  }
}

function cents(value: string): number {
  const amount = Number(value);
  if (!Number.isFinite(amount)) throw new BadRequestException('Invalid webhook amount');
  return Math.round(amount * 100);
}
