import { ConflictException } from '@nestjs/common';

/**
 * Thrown when a FIFO decrement cannot be satisfied by the union of valid
 * (non-expired, non-depleted) batches. The race-safe place to catch this
 * is inside the caller's checkout or billing `$transaction`.
 */
export class OutOfStockError extends ConflictException {
  constructor(
    public readonly variantId: string,
    public readonly requested: number,
    public readonly available: number,
  ) {
    super(
      `Insufficient stock for variant ${variantId}: requested ${requested}, available ${available}`,
    );
  }
}
