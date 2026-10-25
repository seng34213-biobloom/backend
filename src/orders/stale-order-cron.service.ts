import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AuditActorType, OrderStatus, PaymentStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { CronLockService } from '../common/locks/cron-lock.service';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';

const DEFAULT_TIMEOUT_MINUTES = 30;
const BATCH_SIZE = 200;

/**
 * Checkout takes stock when it creates a PENDING_PAYMENT order. If the
 * customer never pays, this job cancels the order once it is older than
 * PENDING_ORDER_TIMEOUT_MINUTES (30 by default), marks its pending payment
 * FAILED and returns its units to batches that have not expired, with a
 * SYSTEM audit entry. The cancel is guarded on the status, so a payment that
 * lands first wins; one that lands afterwards is refunded by PaymentsService.
 */
@Injectable()
export class StaleOrderCronService {
  private readonly logger = new Logger(StaleOrderCronService.name);
  private readonly timeoutMinutes: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly audit: AuditService,
    private readonly locks: CronLockService,
    config: ConfigService,
  ) {
    this.timeoutMinutes =
      Number(config.get('PENDING_ORDER_TIMEOUT_MINUTES')) || DEFAULT_TIMEOUT_MINUTES;
  }

  /** One lock per ten-minute slot, so only one instance cleans up each time. */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async runScheduled(): Promise<{ cancelled: number } | null> {
    const slot = Math.floor(Date.now() / 600_000);
    return this.locks.runExclusive(`stale-orders:${slot}`, 540, () => this.cancelStale());
  }

  async cancelStale(now: Date = new Date()): Promise<{ cancelled: number }> {
    const cutoff = new Date(now.getTime() - this.timeoutMinutes * 60_000);
    const stale = await this.prisma.order.findMany({
      where: { status: OrderStatus.PENDING_PAYMENT, placedAt: { lt: cutoff } },
      orderBy: { placedAt: 'asc' },
      take: BATCH_SIZE,
      select: { id: true },
    });

    let cancelled = 0;
    for (const order of stale) {
      try {
        const restocked = await this.prisma.$transaction(async (tx) => {
          const { count } = await tx.order.updateMany({
            where: { id: order.id, status: OrderStatus.PENDING_PAYMENT },
            data: {
              status: OrderStatus.CANCELLED,
              paymentStatus: PaymentStatus.FAILED,
              cancelledAt: now,
            },
          });
          if (count === 0) return null;
          await tx.payment.updateMany({
            where: { orderId: order.id, status: PaymentStatus.PENDING },
            data: { status: PaymentStatus.FAILED, processedAt: now },
          });
          return this.inventory.restockOrderItems(order.id, tx);
        });
        if (!restocked) continue;

        cancelled++;
        await this.audit.record({
          actorType: AuditActorType.SYSTEM,
          actorId: null,
          action: 'order.cancelled',
          targetType: 'Order',
          targetId: order.id,
          metadata: {
            from: OrderStatus.PENDING_PAYMENT,
            to: OrderStatus.CANCELLED,
            reason: 'payment_timeout',
            timeoutMinutes: this.timeoutMinutes,
            restocked,
          },
        });
      } catch (e) {
        this.logger.error(`Could not cancel stale order ${order.id}: ${(e as Error).message}`);
      }
    }

    if (stale.length > 0) {
      this.logger.log(`Stale orders: found=${stale.length} cancelled=${cancelled}`);
    }
    return { cancelled };
  }
}
