import { PrismaService } from '../prisma/prisma.service';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

const PAID_STATUSES = ['PAID', 'PACKING', 'SHIPPED', 'DELIVERED'];

const startOfTodayUtc = () => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
};
const daysFromToday = (n: number) => new Date(startOfTodayUtc().getTime() + n * 86_400_000);
const isoDay = (n: number) => daysFromToday(n).toISOString().slice(0, 10);

describe('AnalyticsService', () => {
  let prisma: jest.Mocked<PrismaService>;
  let svc: AnalyticsService;

  beforeEach(() => {
    prisma = {
      order: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { totalAmount: '2750.5' } }),
        count: jest.fn().mockResolvedValue(4),
        findMany: jest.fn().mockResolvedValue([]),
      },
      subscription: { count: jest.fn().mockResolvedValue(7) },
      productBatch: { count: jest.fn().mockResolvedValue(2) },
      orderItem: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as jest.Mocked<PrismaService>;
    svc = new AnalyticsService(prisma);
  });

  describe('dashboard', () => {
    it('returns the four KPIs', async () => {
      await expect(svc.dashboard()).resolves.toEqual({
        todayRevenue: '2750.50',
        pendingOrders: 4,
        activeSubscriptions: 7,
        batchesExpiringSoon: 2,
      });
    });

    it("counts only today's paid orders as revenue", async () => {
      await svc.dashboard();

      const where = (prisma.order.aggregate as jest.Mock).mock.calls[0][0].where;
      expect(where.status).toEqual({ in: PAID_STATUSES });
      expect(where.status.in).not.toContain('PENDING_PAYMENT');
      expect(where.placedAt.gte.getTime()).toBe(daysFromToday(0).getTime());
      expect(where.placedAt.lt.getTime()).toBe(daysFromToday(1).getTime());
    });

    it('counts PAID and PACKING orders as pending, ACTIVE subscriptions, and batches expiring within 7 days', async () => {
      await svc.dashboard();

      expect((prisma.order.count as jest.Mock).mock.calls[0][0].where).toEqual({
        status: { in: ['PAID', 'PACKING'] },
      });
      expect((prisma.subscription.count as jest.Mock).mock.calls[0][0].where).toEqual({
        status: 'ACTIVE',
      });
      const batchWhere = (prisma.productBatch.count as jest.Mock).mock.calls[0][0].where;
      expect(batchWhere.status).toEqual({ notIn: ['EXPIRED', 'DEPLETED'] });
      expect(batchWhere.expiryDate.gte.getTime()).toBe(daysFromToday(0).getTime());
      expect(batchWhere.expiryDate.lte.getTime()).toBe(daysFromToday(7).getTime());
    });

    it('reports "0.00" revenue on a day with no paid orders', async () => {
      (prisma.order.aggregate as jest.Mock).mockResolvedValue({ _sum: { totalAmount: null } });
      await expect(svc.dashboard()).resolves.toMatchObject({ todayRevenue: '0.00' });
    });
  });

  describe('revenueSeries', () => {
    it('returns one zero-filled point per day for 30 days by default', async () => {
      const series = await svc.revenueSeries();

      expect(series).toHaveLength(30);
      expect(series[0]).toEqual({ date: isoDay(-29), total: '0.00' });
      expect(series[29]).toEqual({ date: isoDay(0), total: '0.00' });
    });

    it('sums paid orders into their UTC day', async () => {
      (prisma.order.findMany as jest.Mock).mockResolvedValue([
        { placedAt: new Date(daysFromToday(-1).getTime() + 3_600_000), totalAmount: '700' },
        { placedAt: new Date(daysFromToday(-1).getTime() + 7_200_000), totalAmount: '50.25' },
        { placedAt: new Date(daysFromToday(0).getTime() + 60_000), totalAmount: '1000' },
      ]);

      const series = await svc.revenueSeries(3);

      expect(series).toEqual([
        { date: isoDay(-2), total: '0.00' },
        { date: isoDay(-1), total: '750.25' },
        { date: isoDay(0), total: '1000.00' },
      ]);
      const where = (prisma.order.findMany as jest.Mock).mock.calls[0][0].where;
      expect(where.status).toEqual({ in: PAID_STATUSES });
      expect(where.placedAt.gte.getTime()).toBe(daysFromToday(-2).getTime());
    });
  });

  describe('topSelling', () => {
    const item = (productId: string, name: string, quantity: number, lineTotal: string) => ({
      quantity,
      lineTotal,
      variant: { product: { id: productId, name } },
    });

    it('ranks products by revenue this month, adding up every variant', async () => {
      (prisma.orderItem.findMany as jest.Mock).mockResolvedValue([
        item('p-jam', 'Strawberry Jam', 2, '1700'),
        item('p-honey', 'Wild Honey', 1, '1500'),
        item('p-jam', 'Strawberry Jam', 1, '850'),
        item('p-tea', 'Ceylon Tea', 3, '600'),
      ]);

      await expect(svc.topSelling(2)).resolves.toEqual([
        { productId: 'p-jam', productName: 'Strawberry Jam', unitsSold: 3, revenue: '2550.00' },
        { productId: 'p-honey', productName: 'Wild Honey', unitsSold: 1, revenue: '1500.00' },
      ]);

      const where = (prisma.orderItem.findMany as jest.Mock).mock.calls[0][0].where;
      const today = startOfTodayUtc();
      expect(where.order.status).toEqual({ in: PAID_STATUSES });
      expect(where.order.placedAt.gte.getTime()).toBe(
        Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1),
      );
      expect(where.order.placedAt.lt.getTime()).toBe(
        Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1),
      );
    });

    it('returns an empty list when nothing sold this month', async () => {
      await expect(svc.topSelling()).resolves.toEqual([]);
    });
  });
});

describe('AnalyticsController', () => {
  const service = {
    dashboard: jest.fn().mockResolvedValue({}),
    revenueSeries: jest.fn().mockResolvedValue([]),
    topSelling: jest.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<AnalyticsService>;
  const controller = new AnalyticsController(service);

  it('passes the dashboard request through', async () => {
    await controller.dashboard();
    expect(service.dashboard).toHaveBeenCalled();
  });

  it('keeps the revenue window between 1 and 365 days', async () => {
    await controller.revenue(30);
    await controller.revenue(0);
    await controller.revenue(1000);
    expect((service.revenueSeries as jest.Mock).mock.calls).toEqual([[30], [1], [365]]);
  });

  it('keeps the top-selling limit between 1 and 50', async () => {
    await controller.topSelling(5);
    await controller.topSelling(-3);
    await controller.topSelling(500);
    expect((service.topSelling as jest.Mock).mock.calls).toEqual([[5], [1], [50]]);
  });
});
