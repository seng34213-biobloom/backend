import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditActorType, Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import type { AdminSubscriptionsQueryDto } from './dto/admin-subscriptions-query.dto';
import { SubscriptionsService } from './subscriptions.service';

/** Admin oversight of Subscribe & Save (SDS §6.7). The state rules stay in SubscriptionsService. */
@Injectable()
export class SubscriptionsAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: SubscriptionsService,
    private readonly audit: AuditService,
  ) {}

  async list(query: AdminSubscriptionsQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const where: Prisma.SubscriptionWhereInput = query.status ? { status: query.status } : {};
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.subscription.count({ where }),
      this.prisma.subscription.findMany({
        where,
        orderBy: { nextBillingDate: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          status: true,
          frequencyDays: true,
          quantity: true,
          discountRate: true,
          nextBillingDate: true,
          paymentGateway: true,
          customer: { select: { id: true, name: true, email: true } },
          variant: {
            select: {
              id: true,
              name: true,
              size: true,
              price: true,
              product: { select: { id: true, name: true, slug: true } },
            },
          },
        },
      }),
    ]);

    return {
      items: rows.map(({ variant, ...sub }) => ({
        ...sub,
        discountRate: sub.discountRate.toFixed(4),
        discountedUnitPrice: variant.price
          .times(new Prisma.Decimal(1).minus(sub.discountRate))
          .toFixed(2),
        product: variant.product,
        variant: { id: variant.id, name: variant.name, size: variant.size },
      })),
      total,
      page,
      pageSize,
    };
  }

  async change(id: string, action: 'pause' | 'resume' | 'cancel', actor: AuthenticatedUser) {
    const sub = await this.prisma.subscription.findUnique({
      where: { id },
      select: { id: true, customerId: true, status: true },
    });
    if (!sub) throw new NotFoundException(`Subscription ${id} not found`);

    const updated = await this.subscriptions[action](sub.customerId, id);
    await this.audit.record({
      actorType: AuditActorType.ADMIN,
      actorId: actor.id,
      action: `subscription.${action}`,
      targetType: 'Subscription',
      targetId: id,
      metadata: { customerId: sub.customerId, from: sub.status, to: updated.status },
    });
    return updated;
  }
}
