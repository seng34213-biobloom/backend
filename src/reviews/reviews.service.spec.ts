import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { AuditActorType, OrderStatus, ReviewStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { ReviewsService } from './reviews.service';

describe('ReviewsService', () => {
  let service: ReviewsService;
  let prisma: jest.Mocked<PrismaService>;
  let audit: jest.Mocked<Pick<AuditService, 'record'>>;
  const admin: AuthenticatedUser = {
    id: 'admin-1',
    email: 'admin@example.com',
    role: 'ADMIN',
    actorType: 'admin',
    jti: 'jti',
    expiresAt: 0,
  };
  const pendingReview = {
    id: 'review-1',
    customerId: 'customer-1',
    productId: 'product-1',
    orderId: 'order-1',
    status: ReviewStatus.PENDING,
    rating: 5,
    comment: 'Excellent product',
  };

  beforeEach(() => {
    prisma = {
      product: { findUnique: jest.fn().mockResolvedValue({ id: 'product-1' }) },
      order: { findFirst: jest.fn().mockResolvedValue({ id: 'order-1' }) },
      productReview: {
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn().mockResolvedValue(pendingReview),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        aggregate: jest.fn(),
        groupBy: jest.fn(),
      },
    } as unknown as jest.Mocked<PrismaService>;
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new ReviewsService(prisma, audit as unknown as AuditService);
  });

  it('returns 404 for an unknown product', async () => {
    (prisma.product.findUnique as jest.Mock).mockResolvedValue(null);

    await expect(
      service.create('missing', 'customer-1', { rating: 5, comment: 'Excellent product' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('requires a delivered order containing the product', async () => {
    (prisma.order.findFirst as jest.Mock).mockResolvedValue(null);

    await expect(
      service.create('product-1', 'customer-1', { rating: 5, comment: 'Excellent product' }),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.order.findFirst).toHaveBeenCalledWith({
      where: {
        customerId: 'customer-1',
        status: OrderStatus.DELIVERED,
        items: { some: { variant: { productId: 'product-1' } } },
      },
      select: { id: true },
    });
  });

  it('accepts one review from a verified purchaser as pending moderation', async () => {
    await service.create('product-1', 'customer-1', {
      rating: 5,
      comment: '  Excellent product  ',
    });

    expect(prisma.productReview.create).toHaveBeenCalledWith({
      data: {
        customerId: 'customer-1',
        productId: 'product-1',
        orderId: 'order-1',
        rating: 5,
        comment: 'Excellent product',
      },
    });
  });

  it('rejects a second review from the same customer', async () => {
    (prisma.productReview.findUnique as jest.Mock).mockResolvedValue({ id: 'review-1' });

    await expect(
      service.create('product-1', 'customer-1', { rating: 4, comment: 'Still excellent' }),
    ).rejects.toThrow(ConflictException);
    expect(prisma.productReview.create).not.toHaveBeenCalled();
  });

  it('approves a pending review and records an audit entry', async () => {
    (prisma.productReview.findUnique as jest.Mock).mockResolvedValue(pendingReview);
    (prisma.productReview.findUniqueOrThrow as jest.Mock).mockResolvedValue({
      ...pendingReview,
      status: ReviewStatus.APPROVED,
    });

    await service.approve('review-1', admin);

    expect(prisma.productReview.updateMany).toHaveBeenCalledWith({
      where: { id: 'review-1', status: ReviewStatus.PENDING },
      data: { status: ReviewStatus.APPROVED },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: AuditActorType.ADMIN,
        action: 'review.approve',
        targetId: 'review-1',
      }),
    );
  });

  it('deletes a rejected review and records an audit entry', async () => {
    (prisma.productReview.findUnique as jest.Mock).mockResolvedValue(pendingReview);

    await expect(service.reject('review-1', admin)).resolves.toEqual({
      deleted: true,
      reviewId: 'review-1',
    });
    expect(prisma.productReview.deleteMany).toHaveBeenCalledWith({
      where: { id: 'review-1', status: ReviewStatus.PENDING },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'review.reject',
        targetId: 'review-1',
      }),
    );
  });

  it('does not list pending reviews publicly', async () => {
    await service.listApproved('product-1');

    expect(prisma.productReview.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { productId: 'product-1', status: ReviewStatus.APPROVED },
      }),
    );
  });

  it('rejects moderation of an already processed review', async () => {
    (prisma.productReview.findUnique as jest.Mock).mockResolvedValue({
      ...pendingReview,
      status: ReviewStatus.APPROVED,
    });

    await expect(service.reject('review-1', admin)).rejects.toThrow(BadRequestException);
    expect(prisma.productReview.deleteMany).not.toHaveBeenCalled();
  });
});
