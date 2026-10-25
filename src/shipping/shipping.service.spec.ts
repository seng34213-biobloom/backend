import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { ShippingService } from './shipping.service';

describe('ShippingService', () => {
  let service: ShippingService;
  let prisma: jest.Mocked<PrismaService>;
  let redis: jest.Mocked<RedisService>;
  let cache: { get: jest.Mock; set: jest.Mock; del: jest.Mock };
  let cachedRates: string | null;

  beforeEach(() => {
    cachedRates = null;
    cache = {
      get: jest.fn().mockImplementation(async () => cachedRates),
      set: jest.fn().mockImplementation(async (_key: string, value: string) => {
        cachedRates = value;
        return 'OK';
      }),
      del: jest.fn().mockImplementation(async () => {
        cachedRates = null;
        return 1;
      }),
    };
    prisma = {
      shippingRate: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'rate-1', minWeightG: 0, maxWeightG: 500, feeLkr: '350', label: '0-500 g' },
          { id: 'rate-2', minWeightG: 501, maxWeightG: 1000, feeLkr: '500', label: '501 g - 1 kg' },
          { id: 'rate-3', minWeightG: 1001, maxWeightG: 2000, feeLkr: '750', label: '1-2 kg' },
        ]),
      },
    } as unknown as jest.Mocked<PrismaService>;
    redis = {
      getClient: jest.fn().mockReturnValue(cache),
    } as unknown as jest.Mocked<RedisService>;
    service = new ShippingService(prisma, redis);
  });

  it('sums item weights and selects the matching bracket inclusively', async () => {
    expect(service.totalWeightGrams([{ unitWeightGrams: 300, quantity: 2 }])).toBe(600);
    await expect(service.calculate([{ unitWeightGrams: 300, quantity: 2 }])).resolves.toEqual({
      totalWeightG: 600,
      feeLkr: '500.00',
      bracketId: 'rate-2',
      bracketLabel: '501 g - 1 kg',
    });
    expect(cache.set).toHaveBeenCalledWith('shipping:rates', expect.any(String), 'EX', 300);
  });

 it('calculates the 1250 g total from multiple cart items', async () => {
    await expect(
      service.calculate([
        { unitWeightGrams: 250, quantity: 2 },
        { unitWeightGrams: 750, quantity: 1 },
      ]),
    ).resolves.toEqual({
      totalWeightG: 1250,
      feeLkr: '750.00',
      bracketId: 'rate-3',
      bracketLabel: '1-2 kg',
    });
  });

  it.each([
    [500, '350.00', '0-500 g', 'rate-1'],
    [501, '500.00', '501 g - 1 kg', 'rate-2'],
  ])('uses the correct inclusive rate at %d g boundary', async (weight, fee, label, bracketId) => {
    await expect(
      service.calculate([{ unitWeightGrams: weight, quantity: 1 }]),
    ).resolves.toMatchObject({
      totalWeightG: weight,
      feeLkr: fee,
      bracketLabel: label,
      bracketId,
    });
  });

  it('uses valid cached rates without querying the database', async () => {
    cache.get.mockResolvedValue(
      JSON.stringify([
        { id: 'cached', minWeightG: 0, maxWeightG: 1000, feeLkr: '99.00', label: 'cached' },
      ]),
    );
    await expect(service.calculate([{ unitWeightGrams: 1, quantity: 1 }])).resolves.toMatchObject({
      feeLkr: '99.00',
      bracketLabel: 'cached',
    });
    expect(prisma.shippingRate.findMany).not.toHaveBeenCalled();
  });

  it('serves a second quote from the Redis cache within its five-minute TTL', async () => {
    await service.calculate([{ unitWeightGrams: 500, quantity: 1 }]);
    await service.calculate([{ unitWeightGrams: 501, quantity: 1 }]);

    expect(prisma.shippingRate.findMany).toHaveBeenCalledTimes(1);
    expect(cache.set).toHaveBeenCalledWith('shipping:rates', expect.any(String), 'EX', 300);
  });

  it('invalidates cached rates so the next quote reloads them from the database', async () => {
    await service.calculate([{ unitWeightGrams: 500, quantity: 1 }]);
    await service.invalidateCache();
    await service.calculate([{ unitWeightGrams: 501, quantity: 1 }]);

    expect(cache.del).toHaveBeenCalledWith('shipping:rates');
    expect(prisma.shippingRate.findMany).toHaveBeenCalledTimes(2);
  });

  it('reports the uncovered weight when no configured bracket matches', async () => {
    await expect(service.calculate([{ unitWeightGrams: 2001, quantity: 1 }])).rejects.toThrow(
      new NotFoundException('No shipping rate covers weight 2001 g'),
    );
  });

  it('logs and reloads malformed cached data', async () => {
    cache.get.mockResolvedValue('{bad json');
    await service.calculate([{ unitWeightGrams: 1, quantity: 1 }]);
    expect(prisma.shippingRate.findMany).toHaveBeenCalledTimes(1);
  });
});
