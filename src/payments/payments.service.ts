import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OrderStatus, PaymentGateway, PaymentStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { PayHereGateway } from './gateways/payhere.gateway';
import { StripeGateway, VerifiedPaymentEvent } from './gateways/stripe.gateway';

export interface PaymentIntent {
  gateway: PaymentGateway;
  gatewayPaymentId: string;
  clientSecret: string | null;
  checkoutUrl?: string;
  checkoutParams?: Record<string, string>;
  amount: string;
  currency: string;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly config: ConfigService,
    private readonly stripe: StripeGateway,
    private readonly payHere: PayHereGateway,
  ) {}

  async createIntent(input: {
    orderId: string;
    amount: string;
    currency: string;
    gateway: PaymentGateway;
  }): Promise<PaymentIntent> {
    let intent: PaymentIntent;

    if (this.config.get<string>('NODE_ENV') === 'test') {
      const suffix = randomUUID().replace(/-/g, '').slice(0, 24);
      const gatewayPaymentId =
        input.gateway === PaymentGateway.STRIPE ? `pi_test_${suffix}` : `payhere_test_${suffix}`;
      intent = {
        gateway: input.gateway,
        gatewayPaymentId,
        clientSecret: `${gatewayPaymentId}_secret_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
        amount: input.amount,
        currency: input.currency,
      };
    } else if (input.gateway === PaymentGateway.STRIPE) {
      const created = await this.stripe.createIntent({
        orderId: input.orderId,
        amount: input.amount,
        currency: input.currency,
      });
      intent = {
        gateway: input.gateway,
        gatewayPaymentId: created.id,
        clientSecret: created.clientSecret,
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
        checkoutUrl: checkout.checkoutUrl,
        checkoutParams: checkout.params,
        amount: input.amount,
        currency: input.currency,
      };
    }

    await this.prisma.payment.create({
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
    return intent;
  }

  async handleStripeWebhook(rawBody: Buffer, signature: string | undefined) {
    return this.applyWebhookEvent(this.stripe.parseWebhook(rawBody, signature));
  }

  async handlePayHereWebhook(payload: Record<string, string>) {
    return this.applyWebhookEvent(this.payHere.parseWebhook(payload));
  }

  private async applyWebhookEvent(event: VerifiedPaymentEvent): Promise<{
    status: 'applied' | 'duplicate';
    orderId: string;
    paymentStatus: PaymentStatus;
  }> {
    const result = await this.prisma.$transaction(async (tx) => {
      const found = await tx.payment.findUnique({
        where: { gatewayPaymentId: event.gatewayPaymentId },
      });
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
}

function cents(value: string): number {
  const amount = Number(value);
  if (!Number.isFinite(amount)) throw new BadRequestException('Invalid webhook amount');
  return Math.round(amount * 100);
}
