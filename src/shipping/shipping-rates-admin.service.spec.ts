import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Role } from '@prisma/client';
import type { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import type { PrismaService } from '../prisma/prisma.service';
import { bracketProblem, ShippingRatesAdminService } from './shipping-rates-admin.service';
import type { ShippingService } from './shipping.service';

const actor = { id: 'admin-1', role: Role.ADMIN } as AuthenticatedUser;
const rates = [
  { id: 'r1', minWeightG: 0, maxWeightG: 500, feeLkr: '200', label: 'Small' },
  { id: 'r2', minWeightG: 501, maxWeightG: 1000, feeLkr: '300', label: 'Medium' },
];

describe('bracketProblem', () => {
  it('accepts contiguous brackets from zero', () => {
    expect(bracketProblem(rates)).toBeNull();
  });

  it.each([
    [[], 'At least one'],
    [[{ minWeightG: 10, maxWeightG: 20 }], 'start at 0'],
    [[{ minWeightG: 0, maxWeightG: -1 }], 'ends before'],
    [
      [
        { minWeightG: 0, maxWeightG: 100 },
        { minWeightG: 50, maxWeightG: 200 },
      ],
      'overlap',
    ],
    [
      [
        { minWeightG: 0, maxWeightG: 100 },
        { minWeightG: 200, maxWeightG: 300 },
      ],
      'not covered',
    ],
  ])('rejects invalid brackets %#', (brackets, message) => {
    expect(bracketProblem(brackets)).toContain(message);
  });
});

describe('ShippingRatesAdminService', () => {
  let prisma: jest.Mocked<PrismaService>;
  let shipping: { invalidateCache: jest.Mock };
  let audit: { record: jest.Mock };
  let service: ShippingRatesAdminService;

  beforeEach(() => {
    prisma = {
      shippingRate: {
        findMany: jest.fn().mockResolvedValue(rates),
        create: jest.fn().mockResolvedValue({ id: 'r3' }),
        update: jest.fn().mockResolvedValue({ id: 'r2' }),
        delete: jest.fn().mockResolvedValue({ id: 'r2' }),
      },
    } as unknown as jest.Mocked<PrismaService>;
    shipping = { invalidateCache: jest.fn().mockResolvedValue(undefined) };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new ShippingRatesAdminService(
      prisma,
      shipping as unknown as ShippingService,
      audit as unknown as AuditService,
    );
  });

  it('adds a bracket and clears the checkout cache', async () => {
    await service.create(
      { minWeightG: 1001, maxWeightG: 2000, feeLkr: '400.00', label: 'Large' },
      actor,
    );

    expect(prisma.shippingRate.create).toHaveBeenCalled();
    expect(shipping.invalidateCache).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'shipping-rate.create' }),
    );
  });

  it('refuses a gap and a negative fee', async () => {
    await expect(
      service.create({ minWeightG: 5000, maxWeightG: 6000, feeLkr: '1', label: 'Gap' }, actor),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(
      service.create({ minWeightG: 1001, maxWeightG: 2000, feeLkr: '-1', label: 'Bad' }, actor),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(prisma.shippingRate.create).not.toHaveBeenCalled();
  });

  it('updates a bracket', async () => {
    await service.update('r2', { feeLkr: '350.00', label: 'Medium box' }, actor);

    expect(prisma.shippingRate.update).toHaveBeenCalled();
    expect(shipping.invalidateCache).toHaveBeenCalled();
  });

  it('answers 404 for an unknown bracket', async () => {
    await expect(service.update('missing', {}, actor)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.remove('missing', actor)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('removes the last bracket but not one in the middle of the range', async () => {
    await expect(service.remove('r2', actor)).resolves.toEqual({ id: 'r2', deleted: true });
    await expect(service.remove('r1', actor)).rejects.toBeInstanceOf(UnprocessableEntityException);
  });
});
