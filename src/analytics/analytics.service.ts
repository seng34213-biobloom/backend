import { Injectable } from '@nestjs/common';
import { BatchStatus, OrderStatus, SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

function startOfTodayUtc(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** Cancelled and refunded orders never count as revenue. "Today" and the series buckets are UTC days. */
const EXCLUDED_STATUSES = [OrderStatus.CANCELLED, OrderStatus.REFUNDED];

function addDaysUtc(base: Date, days: number): Date {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

export interface DashboardKpis {
  todayRevenue: string;
  pendingOrders: number;
  activeSubscriptions: number;
  batchesExpiringSoon: number;
}

export interface RevenuePoint {
  date: string;
  total: string;
}

export interface TopSellingRow {
  productId: string;
  productName: string;
  unitsSold: number;
  revenue: string;
}

/**
 * Admin dashboard KPIs (SDS §6.5). Pure read-only — every method is safe to
 * cache at the edge.
 */
@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async dashboard(): Promise<DashboardKpis> {
    const today = startOfTodayUtc();
    const tomorrow = addDaysUtc(today, 1);
    const sevenDaysOut = addDaysUtc(today, 7);

    const [todayAgg, pending, activeSubs, expiringSoon] = await Promise.all([
      this.prisma.order.aggregate({
        where: {
          placedAt: { gte: today, lt: tomorrow },
          status: { notIn: EXCLUDED_STATUSES },
        },
        _sum: { totalAmount: true },
      }),
      this.prisma.order.count({
        where: { status: { in: [OrderStatus.PAID, OrderStatus.PACKING] } },
      }),
      this.prisma.subscription.count({
        where: { status: SubscriptionStatus.ACTIVE },
      }),
      this.prisma.productBatch.count({
        where: {
          expiryDate: { gte: today, lte: sevenDaysOut },
          status: { notIn: [BatchStatus.EXPIRED, BatchStatus.DEPLETED] },
        },
      }),
    ]);

    return {
      todayRevenue: Number(todayAgg._sum.totalAmount ?? 0).toFixed(2),
      pendingOrders: pending,
      activeSubscriptions: activeSubs,
      batchesExpiringSoon: expiringSoon,
    };
  }

  /** Daily revenue series for the last `days` days, one zero-filled point per day. */
  async revenueSeries(days = 14): Promise<RevenuePoint[]> {
    const today = startOfTodayUtc();
    const from = addDaysUtc(today, -(days - 1));
    const orders = await this.prisma.order.findMany({
      where: {
        placedAt: { gte: from, lt: addDaysUtc(today, 1) },
        status: { notIn: EXCLUDED_STATUSES },
      },
      select: { placedAt: true, totalAmount: true },
    });

    const byDay = new Map<string, number>();
    for (let i = 0; i < days; i++) {
      const d = addDaysUtc(from, i);
      byDay.set(d.toISOString().slice(0, 10), 0);
    }
    for (const o of orders) {
      const key = new Date(
        Date.UTC(o.placedAt.getUTCFullYear(), o.placedAt.getUTCMonth(), o.placedAt.getUTCDate()),
      )
        .toISOString()
        .slice(0, 10);
      byDay.set(key, (byDay.get(key) ?? 0) + Number(o.totalAmount));
    }
    return Array.from(byDay.entries()).map(([date, total]) => ({
      date,
      total: total.toFixed(2),
    }));
  }

  /** Top-selling products this calendar month — for the §6.5 leaderboard. */
  async topSelling(limit = 5): Promise<TopSellingRow[]> {
    const today = startOfTodayUtc();
    const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    const monthEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));

    const items = await this.prisma.orderItem.findMany({
      where: {
        order: {
          placedAt: { gte: monthStart, lt: monthEnd },
          status: { notIn: EXCLUDED_STATUSES },
        },
      },
      include: {
        variant: { include: { product: { select: { id: true, name: true } } } },
      },
    });

    const bucket = new Map<string, { name: string; units: number; revenue: number }>();
    for (const it of items) {
      const product = it.variant.product;
      const cur = bucket.get(product.id) ?? { name: product.name, units: 0, revenue: 0 };
      cur.units += it.quantity;
      cur.revenue += Number(it.lineTotal);
      bucket.set(product.id, cur);
    }
    return Array.from(bucket.entries())
      .map(([productId, v]) => ({
        productId,
        productName: v.name,
        unitsSold: v.units,
        revenue: v.revenue.toFixed(2),
      }))
      .sort((a, b) => Number(b.revenue) - Number(a.revenue))
      .slice(0, limit);
  }
}
