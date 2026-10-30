import { BatchStatus, Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';

/** Prisma client or interactive-transaction handle. */
export type PrismaReader = PrismaService | Prisma.TransactionClient;

/** Start of the current UTC day. Every date rule in the catalogue uses it. */
export function startOfTodayUtc(now: Date = new Date()): Date {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * SDS §5.2 — a batch is sellable when it has not expired (expiry on or after
 * the start of today, UTC), is not DEPLETED and still holds units. This is
 * the same predicate `InventoryService.availableStock` uses; keep them equal.
 */
export function validBatchWhere(today: Date = startOfTodayUtc()): Prisma.ProductBatchWhereInput {
  return {
    expiryDate: { gte: today },
    status: { not: BatchStatus.DEPLETED },
    currentQuantity: { gt: 0 },
  };
}

export interface VariantStock {
  available: number;
  earliestExpiry: Date | null;
}

/**
 * Available units and earliest valid expiry for many variants in one
 * grouped query. Variants without a valid batch map to `{ 0, null }`.
 */
export async function stockByVariant(
  prisma: PrismaReader,
  variantIds: string[],
  today: Date = startOfTodayUtc(),
): Promise<Map<string, VariantStock>> {
  const out = new Map<string, VariantStock>();
  const ids = Array.from(new Set(variantIds));
  for (const id of ids) out.set(id, { available: 0, earliestExpiry: null });
  if (ids.length === 0) return out;

  const rows = await prisma.productBatch.groupBy({
    by: ['productVariantId'],
    where: { productVariantId: { in: ids }, ...validBatchWhere(today) },
    _sum: { currentQuantity: true },
    _min: { expiryDate: true },
  });
  for (const row of rows) {
    out.set(row.productVariantId, {
      available: row._sum?.currentQuantity ?? 0,
      earliestExpiry: row._min?.expiryDate ?? null,
    });
  }
  return out;
}

/** Serialise money as a 2 dp string without going through JS floats. */
export function money(value: Prisma.Decimal | string | number | null | undefined): string {
  if (value === null || value === undefined) return '0.00';
  return new Prisma.Decimal(value).toFixed(2);
}

/** URL-safe slug: lower case ASCII, words joined by dashes, max 80 chars. */
export function slugify(input: string): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return slug || 'item';
}

/**
 * First free slug among `base`, `base-2`, `base-3`, ... given the slugs that
 * already start with `base`.
 */
export async function uniqueSlug(
  base: string,
  existingWithPrefix: (prefix: string) => Promise<string[]>,
): Promise<string> {
  const taken = new Set(await existingWithPrefix(base));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}
