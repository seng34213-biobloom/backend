import { NotFoundException } from '@nestjs/common';
import { Prisma, Role, SubscriptionStatus } from '@prisma/client';
import type { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import type { PrismaService } from '../prisma/prisma.service';
import { SubscriptionsAdminService } from './subscriptions-admin.service';
import type { SubscriptionsService } from './subscriptions.service';

const actor = { id: 'admin-1', role: Role.ADMIN } as AuthenticatedUser;

describe('SubscriptionsAdminService', () => {
  let prisma: jest.Mocked<PrismaService>;
  let subscriptions: { pause: jest.Mock; resume: jest.Mock; cancel: jest.Mock };
  let audit: { record: jest.Mock };
  let service: SubscriptionsAdminService;

  beforeEach(() => {
    prisma = {
      subscription: {
        count: jest.fn().mockResolvedValue(1),
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'sub-1',
            discountRate: new Prisma.Decimal('0.1'),
            customer: { id: 'c1', name: 'Nimal', email: 'n@example.com' },
            variant: {
              id: 'v1',
              name: 'Jam',
              size: '250g',
              price: new Prisma.Decimal('400'),
              product: { id: 'p1', name: 'Jam', slug: 'jam' },
            },
          },
        ]),
        findUnique: jest.fn().mockResolvedValue({
          id: 'sub-1',
          customerId: 'c1',
          status: SubscriptionStatus.ACTIVE,
        }),
      },
      $transaction: jest.fn((work: Promise<unknown>[]) => Promise.all(work)),
    } as unknown as jest.Mocked<PrismaService>;
    const updated = { status: SubscriptionStatus.PAUSED };
    subscriptions = {
      pause: jest.fn().mockResolvedValue(updated),
      resume: jest.fn().mockResolvedValue(updated),
      cancel: jest.fn().mockResolvedValue(updated),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new SubscriptionsAdminService(
      prisma,
      subscriptions as unknown as SubscriptionsService,
      audit as unknown as AuditService,
    );
  });

  it('prices each row with its locked discount', async () => {
    const out = await service.list({ status: SubscriptionStatus.ACTIVE });

    expect(out.items[0]).toMatchObject({
      discountRate: '0.1000',
      discountedUnitPrice: '360.00',
      product: { name: 'Jam' },
      variant: { size: '250g' },
    });
    expect(out.items[0].variant).not.toHaveProperty('price');
  });

  it('acts on behalf of the owning customer and audits the admin', async () => {
    await service.change('sub-1', 'pause', actor);

    expect(subscriptions.pause).toHaveBeenCalledWith('c1', 'sub-1');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'subscription.pause', actorId: actor.id }),
    );
  });

  it('answers 404 for an unknown subscription', async () => {
    (prisma.subscription.findUnique as jest.Mock).mockResolvedValue(null);
    await expect(service.change('missing', 'cancel', actor)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
