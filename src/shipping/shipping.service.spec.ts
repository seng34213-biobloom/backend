import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { ShippingService } from './shipping.service';

describe('ShippingService', () => {
  let service: ShippingService;
  let prisma: jest.Mocked<PrismaService>;
  let redis: jest.Mocked<RedisService>;
  let cache: { get: jest.Mock; set: jest.Mock; del: jest.Mock };

  beforeEach(() => {
    cache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    };
    prisma = {
      shippingRate: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'rate-1', minWeightG: 0, maxWeightG: 500, feeLkr: '350', label: '0-500 g' },
          { id: 'rate-2', minWeightG: 501, maxWeightG: 1000, feeLkr: '500', label: '501 g - 1 kg' },
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

  it.each([
    [500, 'rate-1'],
    [501, 'rate-2'],
  ])('uses the correct shipping bracket at the %i g boundary', async (weight, bracketId) => {
    await expect(
      service.calculate([{ unitWeightGrams: weight, quantity: 1 }]),
    ).resolves.toMatchObject({
      totalWeightG: weight,
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

  it('rejects weights without a configured bracket', async () => {
    await expect(
      service.calculate([{ unitWeightGrams: 2000, quantity: 1 }]),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('logs and reloads malformed cached data', async () => {
    cache.get.mockResolvedValue('{bad json');
    await service.calculate([{ unitWeightGrams: 1, quantity: 1 }]);
    expect(prisma.shippingRate.findMany).toHaveBeenCalledTimes(1);
  });
});
