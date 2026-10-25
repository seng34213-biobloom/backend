import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OrderStatus, PaymentStatus, Prisma, SubscriptionStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { InventoryService } from '../inventory/inventory.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PaymentsService } from '../payments/payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { ShippingService } from '../shipping/shipping.service';
import { addDaysUtc, startOfTodayUtc } from './subscriptions.service';
import { TokenCipherService } from './token-cipher.service';

export interface BillingRunResult {
  due: number;
  renewed: number;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/**
 * SDS §5.4 — daily Subscribe & Save billing at 06:00 UTC. Each ACTIVE
 * subscription whose billing date has come is charged the discounted price
 * plus shipping on its stored token. One transaction then takes the stock
 * FIFO, creates the PAID order and its PAID payment row, and moves the
 * billing date one interval forward from its previous value, so a late run
 * keeps the customer's schedule.
 */
@Injectable()
export class BillingCronService {
  private readonly logger = new Logger(BillingCronService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly shipping: ShippingService,
    private readonly payments: PaymentsService,
    private readonly notifications: NotificationsService,
    private readonly cipher: TokenCipherService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_6AM)
  async runDaily(): Promise<BillingRunResult> {
    return this.runBilling();
  }

  /** The scheduled run, callable directly from tests. */
  async runBilling(today: Date = startOfTodayUtc()): Promise<BillingRunResult> {
    const due = await this.prisma.subscription.findMany({
      where: { status: SubscriptionStatus.ACTIVE, nextBillingDate: { lte: today } },
      orderBy: { nextBillingDate: 'asc' },
      select: { id: true },
    });

    const result: BillingRunResult = { due: due.length, renewed: 0 };
    for (const sub of due) {
      await this.processOne(sub.id);
      result.renewed++;
    }

    this.logger.log(`Billing run: due=${result.due} renewed=${result.renewed}`);
    return result;
  }

  private async processOne(subscriptionId: string): Promise<void> {
    const sub = await this.prisma.subscription.findUniqueOrThrow({
      where: { id: subscriptionId },
      include: { variant: { select: { price: true, unitWeightGrams: true } } },
    });
    const cycleDate = sub.nextBillingDate;
    const nextDate = addDaysUtc(cycleDate, sub.frequencyDays);

    // Price × quantity × (1 − locked discount), plus the weight-based shipping fee
    const unitPrice = sub.variant.price
      .mul(new Prisma.Decimal(1).minus(sub.discountRate))
      .toDecimalPlaces(2);
    const quote = await this.shipping.calculate([
      { unitWeightGrams: sub.variant.unitWeightGrams, quantity: sub.quantity },
    ]);
    const total = unitPrice.mul(sub.quantity).plus(quote.feeLkr);

    const paymentId = randomUUID();
    const charge = await this.payments.chargeStoredToken({
      paymentId,
      gateway: sub.paymentGateway,
      token: await this.cipher.decrypt(sub.paymentTokenEncrypted),
      amount: total.toFixed(2),
      currency: 'LKR',
      idempotencyKey: `${sub.id}:${ymd(cycleDate)}`,
      description: `Bio Bloom Subscribe & Save ${ymd(cycleDate)}`,
    });
    if (!charge.succeeded) {
      throw new Error(`Charge declined: ${charge.failureReason ?? 'declined'}`);
    }

    const orderId = await this.prisma.$transaction(async (tx) => {
      const draws = await this.inventory.decrementForVariant(
        sub.productVariantId,
        sub.quantity,
        tx,
      );
      const order = await tx.order.create({
        data: {
          customerId: sub.customerId,
          shippingAddressId: sub.shippingAddressId,
          status: OrderStatus.PAID,
          paymentStatus: PaymentStatus.PAID,
          totalAmount: total,
          totalWeight: quote.totalWeightG.toFixed(2),
          shippingFee: quote.feeLkr,
          currency: 'LKR',
          notes: `Subscribe & Save renewal for ${ymd(cycleDate)}`,
          items: {
            create: draws.map((draw) => ({
              productVariantId: sub.productVariantId,
              batchId: draw.batchId,
              quantity: draw.qtyTaken,
              unitPriceSnapshot: unitPrice,
              lineTotal: unitPrice.mul(draw.qtyTaken),
            })),
          },
        },
      });
      await tx.payment.create({
        data: {
          id: paymentId,
          orderId: order.id,
          subscriptionId: sub.id,
          gateway: sub.paymentGateway,
          gatewayPaymentId: charge.gatewayPaymentId ?? `charge_${paymentId}`,
          amount: total,
          currency: 'LKR',
          status: PaymentStatus.PAID,
          processedAt: new Date(),
        },
      });
      await tx.subscription.updateMany({
        where: { id: sub.id, nextBillingDate: cycleDate },
        data: { nextBillingDate: nextDate },
      });
      return order.id;
    });

    this.notifications.emitSubscriptionRenewed({
      subscriptionId: sub.id,
      customerId: sub.customerId,
      orderId,
      amount: total.toFixed(2),
      currency: 'LKR',
    });
  }
}
