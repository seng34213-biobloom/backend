import { Injectable, NotFoundException } from '@nestjs/common';
import { BatchStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import type { ListProductsQueryDto } from './dto/list-products-query.dto';

export interface ProductListItem {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  basePrice: string;
  unitWeightGrams: number;
  variants: Array<{
    id: string;
    sku: string;
    name: string;
    size: string;
    price: string;
    unitWeightGrams: number;
  }>;
}

function startOfTodayUtc(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * SDS §5.2 — public products surface. Hides anything that has zero
 * non-expired, non-depleted stock so a customer never sees a SKU they
 * can't actually buy. PDP detail returns variants with live stock numbers
 * (SDS §6.2 FIFO indicator).
 */
@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
  ) {}

  async list(query: ListProductsQueryDto): Promise<{
    items: ProductListItem[];
    page: number;
    pageSize: number;
    total: number;
  }> {
    const today = startOfTodayUtc();
    const where = {
      active: true,
      ...(query.category ? { category: query.category } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' as const } },
              { description: { contains: query.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
      variants: {
        some: {
          active: true,
          batches: {
            some: {
              expiryDate: { gte: today },
              status: { not: BatchStatus.DEPLETED },
              currentQuantity: { gt: 0 },
            },
          },
        },
      },
    };

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.product.count({ where }),
      this.prisma.product.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          variants: {
            where: { active: true },
            orderBy: { unitWeightGrams: 'asc' },
          },
        },
      }),
    ]);

    return {
      items: rows.map((p) => ({
        id: p.id,
        slug: p.slug,
        name: p.name,
        description: p.description,
        category: p.category,
        basePrice: p.basePrice.toString(),
        unitWeightGrams: p.unitWeightGrams,
        variants: p.variants.map((v) => ({
          id: v.id,
          sku: v.sku,
          name: v.name,
          size: v.size,
          price: v.price.toString(),
          unitWeightGrams: v.unitWeightGrams,
        })),
      })),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  async getBySlug(slug: string): Promise<
    ProductListItem & {
      stockByVariant: Record<string, number>;
      earliestExpiryByVariant: Record<string, string | null>;
    }
  > {
    const product = await this.prisma.product.findUnique({
      where: { slug },
      include: {
        variants: {
          where: { active: true },
          orderBy: { unitWeightGrams: 'asc' },
        },
      },
    });
    if (!product || !product.active) {
      throw new NotFoundException(`Product ${slug} not found`);
    }

    const today = startOfTodayUtc();
    const stockByVariant: Record<string, number> = {};
    const earliestExpiryByVariant: Record<string, string | null> = {};
    await Promise.all(
      product.variants.map(async (v) => {
        stockByVariant[v.id] = await this.inventory.availableStock(v.id);
        const earliest = await this.prisma.productBatch.findFirst({
          where: {
            productVariantId: v.id,
            expiryDate: { gte: today },
            status: { not: BatchStatus.DEPLETED },
            currentQuantity: { gt: 0 },
          },
          orderBy: { expiryDate: 'asc' },
          select: { expiryDate: true },
        });
        earliestExpiryByVariant[v.id] = earliest?.expiryDate.toISOString() ?? null;
      }),
    );

    return {
      id: product.id,
      slug: product.slug,
      name: product.name,
      description: product.description,
      category: product.category,
      basePrice: product.basePrice.toString(),
      unitWeightGrams: product.unitWeightGrams,
      variants: product.variants.map((v) => ({
        id: v.id,
        sku: v.sku,
        name: v.name,
        size: v.size,
        price: v.price.toString(),
        unitWeightGrams: v.unitWeightGrams,
      })),
      stockByVariant,
      earliestExpiryByVariant,
    };
  }
}
