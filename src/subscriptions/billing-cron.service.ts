import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OrderStatus, PaymentStatus, Prisma, SubscriptionStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { CronLockService } from '../common/locks/cron-lock.service';
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
  outOfStock: number;
  chargeFailed: number;
  errored: number;
}

type Outcome = 'renewed' | 'outOfStock' | 'chargeFailed';

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/**
 * SDS §5.4 — daily Subscribe & Save billing at 06:00 UTC. For each ACTIVE
 * subscription whose billing date has come:
 *   1. Short stock, or a variant no longer sold: nothing is charged and
 *      `subscription.stockDelayed` is emitted.
 *   2. The stored token is charged the discounted price plus shipping. A
 *      decline creates no order and takes no stock; a FAILED payment row
 *      records the attempt (SDS §7.5) and `subscription.chargeFailed` is
 *      emitted.
 *   3. Paid: one transaction takes the stock FIFO and creates the PAID order
 *      and its PAID payment row, then `subscription.renewed` is emitted.
 * Whatever the outcome, the billing date moves one interval forward from its
 * previous value, so a late run keeps the customer's schedule. Each
 * subscription is isolated, so one failure never stops the run.
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
    private readonly locks: CronLockService,
  ) {}

  /** Only the instance that takes today's lock bills; the others skip. */
  @Cron(CronExpression.EVERY_DAY_AT_6AM)
  async runDaily(): Promise<BillingRunResult | null> {
    return this.locks.runExclusive(CronLockService.daily('billing'), 3600, () => this.runBilling());
  }

  /** The scheduled run, callable directly from tests. */
  async runBilling(today: Date = startOfTodayUtc()): Promise<BillingRunResult> {
    const due = await this.prisma.subscription.findMany({
      where: { status: SubscriptionStatus.ACTIVE, nextBillingDate: { lte: today } },
      orderBy: { nextBillingDate: 'asc' },
      select: { id: true, nextBillingDate: true, frequencyDays: true },
    });

    const result: BillingRunResult = {
      due: due.length,
      renewed: 0,
      outOfStock: 0,
      chargeFailed: 0,
      errored: 0,
    };
    for (const sub of due) {
      try {
        result[await this.processOne(sub.id)]++;
      } catch (e) {
        result.errored++;
        this.logger.error(`Billing failed for subscription=${sub.id}: ${(e as Error).message}`);
        // Still move the date on, so the next run does not retry the same cycle
        await this.advance(
          sub.id,
          sub.nextBillingDate,
          addDaysUtc(sub.nextBillingDate, sub.frequencyDays),
        ).catch((err: Error) =>
          this.logger.error(`Could not advance subscription=${sub.id}: ${err.message}`),
        );
      }
    }

    this.logger.log(
      `Billing run: due=${result.due} renewed=${result.renewed} outOfStock=${result.outOfStock} chargeFailed=${result.chargeFailed} errored=${result.errored}`,
    );
    return result;
  }

  private async processOne(subscriptionId: string): Promise<Outcome> {
    const sub = await this.prisma.subscription.findUniqueOrThrow({
      where: { id: subscriptionId },
      include: { variant: { select: { price: true, unitWeightGrams: true, active: true } } },
    });
    const cycleDate = sub.nextBillingDate;
    const nextDate = addDaysUtc(cycleDate, sub.frequencyDays);

    const available = sub.variant.active
      ? await this.inventory.availableStock(sub.productVariantId)
      : 0;
    if (available < sub.quantity) {
      this.notifications.emitSubscriptionStockDelayed({
        subscriptionId: sub.id,
        customerId: sub.customerId,
        productVariantId: sub.productVariantId,
        requested: sub.quantity,
        available,
      });
      await this.advance(sub.id, cycleDate, nextDate);
      return 'outOfStock';
    }

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
      const reason = charge.failureReason ?? 'declined';
      await this.prisma.payment.create({
        data: {
          id: paymentId,
          subscriptionId: sub.id,
          gateway: sub.paymentGateway,
          gatewayPaymentId: charge.gatewayPaymentId ?? `declined_${paymentId}`,
          amount: total,
          currency: 'LKR',
          status: PaymentStatus.FAILED,
          rawPayload: { failureReason: reason },
          processedAt: new Date(),
        },
      });
      this.notifications.emitSubscriptionChargeFailed({
        subscriptionId: sub.id,
        customerId: sub.customerId,
        reason,
      });
      await this.advance(sub.id, cycleDate, nextDate);
      return 'chargeFailed';
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
    return 'renewed';
  }

  /** Moves the date on from the cycle's own date, and only if no one else has. */
  private async advance(subscriptionId: string, from: Date, to: Date): Promise<void> {
    await this.prisma.subscription.updateMany({
      where: { id: subscriptionId, nextBillingDate: from },
      data: { nextBillingDate: to },
    });
  }
}
