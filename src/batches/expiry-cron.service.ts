import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BatchStatus } from '@prisma/client';
import { CronLockService } from '../common/locks/cron-lock.service';
import { PrismaService } from '../prisma/prisma.service';

export interface BatchExpiringSoonPayload {
  batchId: string;
  productVariantId: string;
  batchNumber: string;
  expiryDate: Date;
  currentQuantity: number;
  daysUntilExpiry: number;
}

export interface BatchExpiredPayload {
  batchId: string;
  productVariantId: string;
  batchNumber: string;
  expiryDate: Date;
  currentQuantity: number;
}

function startOfTodayUtc(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * SDS §5.6 — daily 06:00 UTC sweep.
 *   1. Batches with expiry_date < today + status in (ACTIVE, EXPIRING_SOON)
 *      → status = EXPIRED, emit 'batch.expired'.
 *   2. Batches with expiry_date <= today + 7d + status = ACTIVE
 *      → status = EXPIRING_SOON, emit 'batch.expiringSoon'.
 *
 * The state guard (`status = ACTIVE` for the soon-pass) makes the cron
 * idempotent: re-running the same day moves zero rows the second time.
 */
@Injectable()
export class ExpiryCronService {
  private readonly logger = new Logger(ExpiryCronService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly locks: CronLockService,
  ) {}

  /** Only the instance that takes today's lock sweeps, so admins get one email. */
  @Cron(CronExpression.EVERY_DAY_AT_6AM)
  async runDaily(): Promise<{ expiredCount: number; expiringSoonCount: number } | null> {
    return this.locks.runExclusive(CronLockService.daily('expiry'), 3600, () => this.sweep());
  }

  /** Pure logic separated so tests (and a future admin trigger) can run it directly. */
  async sweep(): Promise<{ expiredCount: number; expiringSoonCount: number }> {
    const today = startOfTodayUtc();
    const sevenDaysOut = new Date(today.getTime() + 7 * 86_400_000);

    // Step 1: mark EXPIRED.
    const expiredCandidates = await this.prisma.productBatch.findMany({
      where: {
        expiryDate: { lt: today },
        status: { in: [BatchStatus.ACTIVE, BatchStatus.EXPIRING_SOON] },
      },
      select: {
        id: true,
        productVariantId: true,
        batchNumber: true,
        expiryDate: true,
        currentQuantity: true,
      },
    });
    if (expiredCandidates.length > 0) {
      await this.prisma.productBatch.updateMany({
        where: { id: { in: expiredCandidates.map((b) => b.id) } },
        data: { status: BatchStatus.EXPIRED },
      });
      for (const b of expiredCandidates) {
        const payload: BatchExpiredPayload = {
          batchId: b.id,
          productVariantId: b.productVariantId,
          batchNumber: b.batchNumber,
          expiryDate: b.expiryDate,
          currentQuantity: b.currentQuantity,
        };
        this.events.emit('batch.expired', payload);
      }
    }

    // Step 2: mark EXPIRING_SOON for batches in the 0–7 day window that
    // are still ACTIVE (not already alerted, not already expired above).
    const soonCandidates = await this.prisma.productBatch.findMany({
      where: {
        expiryDate: { gte: today, lte: sevenDaysOut },
        status: BatchStatus.ACTIVE,
      },
      select: {
        id: true,
        productVariantId: true,
        batchNumber: true,
        expiryDate: true,
        currentQuantity: true,
      },
    });
    if (soonCandidates.length > 0) {
      await this.prisma.productBatch.updateMany({
        where: { id: { in: soonCandidates.map((b) => b.id) } },
        data: { status: BatchStatus.EXPIRING_SOON },
      });
      for (const b of soonCandidates) {
        const days = Math.max(
          0,
          Math.round((b.expiryDate.getTime() - today.getTime()) / 86_400_000),
        );
        const payload: BatchExpiringSoonPayload = {
          batchId: b.id,
          productVariantId: b.productVariantId,
          batchNumber: b.batchNumber,
          expiryDate: b.expiryDate,
          currentQuantity: b.currentQuantity,
          daysUntilExpiry: days,
        };
        this.events.emit('batch.expiringSoon', payload);
      }
    }

    this.logger.log(
      `Expiry sweep: ${expiredCandidates.length} EXPIRED, ${soonCandidates.length} EXPIRING_SOON`,
    );
    return {
      expiredCount: expiredCandidates.length,
      expiringSoonCount: soonCandidates.length,
    };
  }
}
