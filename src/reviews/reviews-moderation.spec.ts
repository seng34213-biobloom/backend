import { NotFoundException } from '@nestjs/common';
import { ReviewStatus, Role } from '@prisma/client';
import type { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import type { PrismaService } from '../prisma/prisma.service';
import { ReviewsService } from './reviews.service';

const admin = { id: 'admin-1', role: Role.ADMIN } as AuthenticatedUser;

describe('ReviewsService moderation list', () => {
  let prisma: jest.Mocked<PrismaService>;
  let audit: { record: jest.Mock };
  let service: ReviewsService;

  beforeEach(() => {
    prisma = {
      productReview: {
        findMany: jest.fn().mockResolvedValue([{ id: 'r1', status: ReviewStatus.APPROVED }]),
        findUnique: jest.fn().mockResolvedValue({
          id: 'r1',
          status: ReviewStatus.APPROVED,
          productId: 'p1',
          customerId: 'c1',
        }),
        delete: jest.fn().mockResolvedValue({ id: 'r1' }),
      },
    } as unknown as jest.Mocked<PrismaService>;
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new ReviewsService(prisma, audit as unknown as AuditService);
  });

  it.each([
    [true, { status: ReviewStatus.APPROVED }],
    [false, { status: ReviewStatus.PENDING }],
    [undefined, undefined],
  ])('filters by approval %#', async (approved, where) => {
    const rows = await service.listForAdmin(approved);

    expect((prisma.productReview.findMany as jest.Mock).mock.calls[0][0].where).toEqual(where);
    expect(rows[0].approved).toBe(true);
  });

  it('removes a review in any state and audits it', async () => {
    await expect(service.remove('r1', admin)).resolves.toEqual({ deleted: true, reviewId: 'r1' });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'review.reject', actorId: admin.id }),
    );
  });

  it('answers 404 for an unknown review', async () => {
    (prisma.productReview.findUnique as jest.Mock).mockResolvedValue(null);
    await expect(service.remove('missing', admin)).rejects.toBeInstanceOf(NotFoundException);
  });
});
