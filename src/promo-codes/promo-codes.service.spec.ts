import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { DiscountType, Prisma, Role } from '@prisma/client';
import type { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import type { PrismaService } from '../prisma/prisma.service';
import { PromoCodesService } from './promo-codes.service';

const actor = { id: 'admin-1', role: Role.ADMIN } as AuthenticatedUser;
const dto = {
  code: ' save10 ',
  discountType: DiscountType.PERCENTAGE,
  discountValue: '10',
  validFrom: '2026-01-01T00:00:00.000Z',
  validUntil: '2030-01-01T00:00:00.000Z',
};
const existing = {
  id: 'promo-1',
  discountType: DiscountType.PERCENTAGE,
  discountValue: new Prisma.Decimal(10),
  validFrom: new Date('2026-01-01'),
  validUntil: new Date('2030-01-01'),
  usedCount: 5,
};

describe('PromoCodesService', () => {
  let prisma: jest.Mocked<PrismaService>;
  let audit: { record: jest.Mock };
  let service: PromoCodesService;

  beforeEach(() => {
    prisma = {
      promoCode: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(existing),
        create: jest.fn().mockResolvedValue({ id: 'promo-1', code: 'SAVE10' }),
        update: jest.fn().mockResolvedValue({ id: 'promo-1' }),
      },
    } as unknown as jest.Mocked<PrismaService>;
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new PromoCodesService(prisma, audit as unknown as AuditService);
  });

  it('lists newest first', async () => {
    await service.list();
    expect(prisma.promoCode.findMany).toHaveBeenCalledWith({ orderBy: { createdAt: 'desc' } });
  });

  it('stores the code in upper case and audits it', async () => {
    await service.create(dto, actor);

    expect((prisma.promoCode.create as jest.Mock).mock.calls[0][0].data.code).toBe('SAVE10');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'promo.create' }));
  });

  it('maps a duplicate code to a conflict', async () => {
    (prisma.promoCode.create as jest.Mock).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    await expect(service.create(dto, actor)).rejects.toBeInstanceOf(ConflictException);
  });

  it.each([
    [{ discountValue: '0' }],
    [{ discountValue: '101' }],
    [{ validUntil: '2025-01-01T00:00:00.000Z' }],
  ])('rejects invalid values %#', async (change) => {
    await expect(service.create({ ...dto, ...change }, actor)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it('updates a code', async () => {
    await service.update('promo-1', { active: false }, actor);

    expect((prisma.promoCode.update as jest.Mock).mock.calls[0][0].data.active).toBe(false);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'promo.update' }));
  });

  it('answers 404 for an unknown code', async () => {
    (prisma.promoCode.findUnique as jest.Mock).mockResolvedValue(null);
    await expect(service.update('missing', {}, actor)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('keeps maxUses above what has been used', async () => {
    await expect(service.update('promo-1', { maxUses: 2 }, actor)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });
});
