import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditActorType, OrderStatus, Prisma, ReviewStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateReviewDto } from './dto/create-review.dto';

@Injectable()
export class ReviewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(productId: string, customerId: string, dto: CreateReviewDto) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { id: true },
    });
    if (!product) throw new NotFoundException(`Product ${productId} not found`);

    const order = await this.prisma.order.findFirst({
      where: {
        customerId,
        status: OrderStatus.DELIVERED,
        items: { some: { variant: { productId } } },
      },
      select: { id: true },
    });
    if (!order) {
      throw new ForbiddenException(
        'A delivered order containing this product is required to review it',
      );
    }

    const existing = await this.prisma.productReview.findUnique({
      where: { customerId_productId: { customerId, productId } },
      select: { id: true },
    });
    if (existing) throw new ConflictException('You have already reviewed this product');

    try {
      return await this.prisma.productReview.create({
        data: {
          customerId,
          productId,
          orderId: order.id,
          rating: dto.rating,
          comment: dto.comment.trim(),
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('You have already reviewed this product');
      }
      throw error;
    }
  }

  async listApproved(productId: string) {
    await this.requireProduct(productId);
    return this.prisma.productReview.findMany({
      where: { productId, status: ReviewStatus.APPROVED },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        rating: true,
        comment: true,
        createdAt: true,
        customer: { select: { name: true } },
      },
    });
  }

  async summary(productId: string) {
    await this.requireProduct(productId);
    const [aggregate, grouped] = await Promise.all([
      this.prisma.productReview.aggregate({
        where: { productId, status: ReviewStatus.APPROVED },
        _avg: { rating: true },
        _count: { _all: true },
      }),
      this.prisma.productReview.groupBy({
        by: ['rating'],
        where: { productId, status: ReviewStatus.APPROVED },
        _count: { _all: true },
      }),
    ]);
    const ratingCounts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const row of grouped) ratingCounts[row.rating] = row._count._all;

    return {
      averageRating: aggregate._avg.rating,
      reviewCount: aggregate._count._all,
      ratingCounts,
    };
  }

  listPending() {
    return this.prisma.productReview.findMany({
      where: { status: ReviewStatus.PENDING },
      orderBy: { createdAt: 'asc' },
      include: {
        customer: { select: { id: true, name: true, email: true } },
        product: { select: { id: true, name: true, slug: true } },
        order: { select: { id: true, deliveredAt: true } },
      },
    });
  }

  async approve(reviewId: string, actor: AuthenticatedUser) {
    const review = await this.requireReview(reviewId);
    if (review.status !== ReviewStatus.PENDING) {
      throw new BadRequestException('Only pending reviews can be approved');
    }

    const result = await this.prisma.productReview.updateMany({
      where: { id: reviewId, status: ReviewStatus.PENDING },
      data: { status: ReviewStatus.APPROVED },
    });
    if (result.count !== 1) throw new ConflictException('Review moderation was already processed');

    const approved = await this.prisma.productReview.findUniqueOrThrow({
      where: { id: reviewId },
    });
    await this.audit.record({
      actorType: AuditActorType.ADMIN,
      actorId: actor.id,
      action: 'review.approve',
      targetType: 'ProductReview',
      targetId: reviewId,
      metadata: { productId: review.productId, customerId: review.customerId },
    });
    return approved;
  }

  async reject(reviewId: string, actor: AuthenticatedUser) {
    const review = await this.requireReview(reviewId);
    if (review.status !== ReviewStatus.PENDING) {
      throw new BadRequestException('Only pending reviews can be rejected');
    }

    const result = await this.prisma.productReview.deleteMany({
      where: { id: reviewId, status: ReviewStatus.PENDING },
    });
    if (result.count !== 1) throw new ConflictException('Review moderation was already processed');

    await this.audit.record({
      actorType: AuditActorType.ADMIN,
      actorId: actor.id,
      action: 'review.reject',
      targetType: 'ProductReview',
      targetId: reviewId,
      metadata: { productId: review.productId, customerId: review.customerId },
    });
    return { deleted: true, reviewId };
  }

  private async requireProduct(productId: string) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { id: true },
    });
    if (!product) throw new NotFoundException(`Product ${productId} not found`);
    return product;
  }

  private async requireReview(reviewId: string) {
    const review = await this.prisma.productReview.findUnique({ where: { id: reviewId } });
    if (!review) throw new NotFoundException(`Review ${reviewId} not found`);
    return review;
  }
}
