import { Injectable, Logger } from '@nestjs/common';
import { BatchStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OutOfStockError } from './inventory.errors';

/** Tx handle accepted by decrementForVariant — supports nested transactions. */
export type PrismaTx = Prisma.TransactionClient | PrismaService;

/**
 * Raw shape returned by the FOR UPDATE query. We alias snake_case columns to
 * camelCase in the SELECT list so we can read them directly — `$queryRaw`
 * does NOT apply Prisma @map() translation.
 */
interface LockedBatchRow {
  id: string;
  productVariantId: string;
  currentQuantity: number;
}

export interface DecrementResult {
  batchId: string;
  qtyTaken: number;
  depleted: boolean;
}

function startOfTodayUtc(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * SDS §4.2 — sole inventory access point. Two responsibilities:
 *   1. availableStock(variantId): aggregate non-expired non-depleted batches
 *      (used for the catalogue "in stock" filter and cart pre-checkout
 *      validation).
 *   2. decrementForVariant(variantId, qty, tx): atomic FIFO decrement under
 *      SELECT ... FOR UPDATE row locks (used by checkout and subscription
 *      billing within their $transaction).
 *
 * The SDS §4.2 also describes a primitive `decrementBatch(batchId, qty)`
 * — that's available as a low-level helper for code paths that already
 * know which batch to touch (manual admin correction).
 */
@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Total available stock for a variant across all VALID batches:
   *   expiry_date >= TODAY AND status != 'DEPLETED' AND current_quantity > 0
   * Returns 0 when no valid batches exist.
   */
  async availableStock(variantId: string): Promise<number> {
    const result = await this.prisma.productBatch.aggregate({
      where: {
        productVariantId: variantId,
        expiryDate: { gte: startOfTodayUtc() },
        status: { not: BatchStatus.DEPLETED },
        currentQuantity: { gt: 0 },
      },
      _sum: { currentQuantity: true },
    });
    return result._sum.currentQuantity ?? 0;
  }

  /** Convenience predicate for cart-add / pre-checkout checks. */
  async checkStock(
    variantId: string,
    qty: number,
  ): Promise<{ available: number; sufficient: boolean }> {
    const available = await this.availableStock(variantId);
    return { available, sufficient: available >= qty };
  }

  /**
   * Atomic FIFO decrement. MUST run inside a Prisma `$transaction` so the
   * SELECT ... FOR UPDATE row locks are released only after the caller's
   * surrounding Order/Subscription row is persisted (SDS §5.3 atomicity).
   *
   * Iterates candidate batches earliest-expiry-first, taking up to each
   * batch's currentQuantity until `qty` is satisfied. Batches that hit
   * 0 are marked DEPLETED. If union of valid batches < qty, throws
   * OutOfStockError (a ConflictException, HTTP 409).
   */
  async decrementForVariant(
    variantId: string,
    qty: number,
    tx: PrismaTx,
  ): Promise<DecrementResult[]> {
    if (qty <= 0) {
      throw new Error(`decrementForVariant requires positive qty; got ${qty}`);
    }

    // Lock candidate rows in earliest-expiry-first order. Columns are aliased
    // to camelCase so the JS-side property reads match. Parameter binding on
    // variantId prevents SQL injection despite the raw query.
    const locked = await tx.$queryRaw<LockedBatchRow[]>(
      Prisma.sql`
        SELECT
          id,
          product_variant_id AS "productVariantId",
          current_quantity   AS "currentQuantity"
        FROM product_batch
        WHERE product_variant_id = ${variantId}::uuid
          AND expiry_date >= CURRENT_DATE
          AND status <> 'DEPLETED'
          AND current_quantity > 0
        ORDER BY expiry_date ASC, batch_number ASC
        FOR UPDATE
      `,
    );

    let remaining = qty;
    const taken: DecrementResult[] = [];

    for (const row of locked) {
      if (remaining <= 0) break;
      const take = Math.min(row.currentQuantity, remaining);
      const newQty = row.currentQuantity - take;
      const depleted = newQty === 0;
      await tx.productBatch.update({
        where: { id: row.id },
        data: {
          currentQuantity: newQty,
          ...(depleted ? { status: BatchStatus.DEPLETED } : {}),
        },
      });
      taken.push({ batchId: row.id, qtyTaken: take, depleted });
      remaining -= take;
    }

    if (remaining > 0) {
      const available = qty - remaining;
      throw new OutOfStockError(variantId, qty, available);
    }

    this.logger.log(`Decremented variant=${variantId} qty=${qty} batches=${taken.length}`);
    return taken;
  }

  /**
   * Primitive single-batch decrement. Used by admin correction tools.
   * Not the checkout path.
   */
  async decrementBatch(batchId: string, qty: number, tx: PrismaTx): Promise<DecrementResult> {
    const batch = await tx.productBatch.findUnique({ where: { id: batchId } });
    if (!batch) throw new Error(`Batch ${batchId} not found`);
    if (batch.currentQuantity < qty) {
      throw new OutOfStockError(batch.productVariantId, qty, batch.currentQuantity);
    }
    const newQty = batch.currentQuantity - qty;
    const depleted = newQty === 0;
    await tx.productBatch.update({
      where: { id: batchId },
      data: {
        currentQuantity: newQty,
        ...(depleted ? { status: BatchStatus.DEPLETED } : {}),
      },
    });
    return { batchId, qtyTaken: qty, depleted };
  }
}
