import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

const SHIPPING_RATES_CACHE_KEY = 'shipping:rates';
const SHIPPING_RATES_TTL_SEC = 300;

export interface ShippingItemWeight {
  unitWeightGrams: number;
  quantity: number;
}

export interface ShippingQuote {
  totalWeightG: number;
  feeLkr: string;
  bracketId: string;
  bracketLabel: string;
}

interface CachedBracket {
  id: string;
  minWeightG: number;
  maxWeightG: number;
  feeLkr: string;
  label: string;
}

function isCachedBracket(value: unknown): value is CachedBracket {
  if (typeof value !== 'object' || value === null) return false;
  const bracket = value as Record<string, unknown>;
  return (
    typeof bracket.id === 'string' &&
    typeof bracket.minWeightG === 'number' &&
    typeof bracket.maxWeightG === 'number' &&
    typeof bracket.feeLkr === 'string' &&
    typeof bracket.label === 'string'
  );
}

@Injectable()
export class ShippingService {
  private readonly logger = new Logger(ShippingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  totalWeightGrams(items: ShippingItemWeight[]): number {
    return items.reduce((total, item) => total + item.unitWeightGrams * item.quantity, 0);
  }

  async calculate(items: ShippingItemWeight[]): Promise<ShippingQuote> {
    const totalWeightG = this.totalWeightGrams(items);
    const brackets = await this.loadBrackets();
    const match = brackets.find(
      (bracket) => bracket.minWeightG <= totalWeightG && totalWeightG <= bracket.maxWeightG,
    );
    if (!match) {
      throw new NotFoundException(`No shipping rate covers weight ${totalWeightG} g`);
    }
    return {
      totalWeightG,
      feeLkr: match.feeLkr,
      bracketId: match.id,
      bracketLabel: match.label,
    };
  }

  async invalidateCache(): Promise<void> {
    await this.redis.getClient().del(SHIPPING_RATES_CACHE_KEY);
  }

  private async loadBrackets(): Promise<CachedBracket[]> {
    const client = this.redis.getClient();
    const cached = await client.get(SHIPPING_RATES_CACHE_KEY);
    if (cached) {
      try {
        const parsed: unknown = JSON.parse(cached);
        if (Array.isArray(parsed) && parsed.every(isCachedBracket)) {
          return parsed;
        }
        this.logger.warn('Ignoring invalid cached shipping rates');
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Ignoring malformed cached shipping rates: ${detail}`);
      }
    }

    const rows = await this.prisma.shippingRate.findMany({
      orderBy: { minWeightG: 'asc' },
    });
    const brackets = rows.map((row) => ({
      id: row.id,
      minWeightG: row.minWeightG,
      maxWeightG: row.maxWeightG,
      feeLkr: Number(row.feeLkr).toFixed(2),
      label: row.label,
    }));
    await client.set(
      SHIPPING_RATES_CACHE_KEY,
      JSON.stringify(brackets),
      'EX',
      SHIPPING_RATES_TTL_SEC,
    );
    this.logger.debug(`Shipping rates refreshed (${brackets.length} brackets)`);
    return brackets;
  }
}
