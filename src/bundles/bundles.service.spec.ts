import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma, Role, SellerStatus } from '@prisma/client';
import type { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import type { PrismaService } from '../prisma/prisma.service';
import { BundlesService } from './bundles.service';

const admin = { id: 'admin-1', role: Role.ADMIN } as AuthenticatedUser;
const seller = { id: 'seller-1', role: Role.SELLER } as AuthenticatedUser;

const bundleRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'bundle-1',
  sellerId: 'seller-1',
  slug: 'breakfast-box',
  name: 'Breakfast Box',
  description: 'Two jams',
  price: new Prisma.Decimal('700'),
  totalWeightG: 500,
  active: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  seller: { id: 'seller-1', businessName: 'Amma', status: SellerStatus.APPROVED },
  items: [
    {
      productVariantId: 'v1',
      quantity: 2,
      variant: {
        id: 'v1',
        sku: 'JAM',
        name: 'Jam',
        size: '250g',
        price: new Prisma.Decimal('400'),
        unitWeightGrams: 250,
        active: true,
        product: {
          id: 'p1',
          name: 'Jam',
          slug: 'jam',
          active: true,
          seller: { status: SellerStatus.APPROVED },
          images: [{ url: 'https://cdn.example.com/jam.jpg' }],
        },
      },
    },
  ],
  ...overrides,
});

describe('BundlesService', () => {
  let prisma: jest.Mocked<PrismaService>;
  let audit: { record: jest.Mock };
  let service: BundlesService;

  beforeEach(() => {
    prisma = {
      bundle: {
        count: jest.fn().mockResolvedValue(1),
        findMany: jest.fn().mockResolvedValue([bundleRow()]),
        findFirst: jest.fn().mockResolvedValue(bundleRow()),
        findUnique: jest.fn().mockResolvedValue(bundleRow()),
        create: jest.fn().mockResolvedValue({ id: 'bundle-1' }),
        update: jest.fn().mockResolvedValue({ id: 'bundle-1' }),
      },
      bundleItem: {
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      seller: {
        findUnique: jest.fn().mockResolvedValue({ status: SellerStatus.APPROVED }),
      },
      productVariant: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'v1',
            active: true,
            unitWeightGrams: 250,
            product: { active: true, sellerId: 'seller-1' },
          },
        ]),
      },
      productBatch: {
        groupBy: jest.fn().mockResolvedValue([
          {
            productVariantId: 'v1',
            _sum: { currentQuantity: 9 },
            _min: { expiryDate: new Date('2030-01-01') },
          },
        ]),
      },
      $transaction: jest.fn(async (work: unknown) =>
        typeof work === 'function'
          ? (work as (tx: unknown) => unknown)(prisma)
          : Promise.all(work as Promise<unknown>[]),
      ),
    } as unknown as jest.Mocked<PrismaService>;
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new BundlesService(prisma, audit as unknown as AuditService);
  });

  const dto = {
    name: 'Breakfast Box',
    description: 'Two jams',
    price: '700.00',
    sellerId: 'seller-1',
    items: [{ productVariantId: 'v1', quantity: 2 }],
  };

  describe('public catalogue', () => {
    it('counts whole boxes from component stock and totals the parts', async () => {
      const out = await service.listPublic({ page: 1, pageSize: 24 });

      expect(out.items[0]).toMatchObject({
        available: 4,
        componentsTotal: '800.00',
        imageUrl: 'https://cdn.example.com/jam.jpg',
      });
    });

    it('hides boxes with nothing to sell', async () => {
      (prisma.productBatch.groupBy as jest.Mock).mockResolvedValue([]);
      expect((await service.listPublic({ page: 1, pageSize: 24 })).total).toBe(0);
    });

    it('treats an in-house product as sellable', async () => {
      const row = bundleRow();
      row.items[0].variant.product.seller = null as never;
      (prisma.bundle.findFirst as jest.Mock).mockResolvedValue(row);

      expect((await service.getPublic('breakfast-box')).available).toBe(4);
    });

    it('answers 404 for an unknown box', async () => {
      (prisma.bundle.findFirst as jest.Mock).mockResolvedValue(null);
      await expect(service.getPublic('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('admin', () => {
    it('limits a seller to their own boxes', async () => {
      await service.listAdmin({ page: 1, pageSize: 24, includeInactive: true }, seller);

      expect((prisma.bundle.findMany as jest.Mock).mock.calls[0][0].where).toEqual({
        sellerId: seller.id,
      });
    });

    it('refuses another seller box', async () => {
      await expect(service.getAdmin('bundle-1', { ...seller, id: 'other' })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('answers 404 for an unknown box', async () => {
      (prisma.bundle.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(service.getAdmin('missing', admin)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.update('missing', {}, admin)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('creates a box and derives its weight from the components', async () => {
      (prisma.bundle.findMany as jest.Mock).mockResolvedValue([]);

      await service.create(dto, admin);

      const { data } = (prisma.bundle.create as jest.Mock).mock.calls[0][0];
      expect(data).toMatchObject({ slug: 'breakfast-box', totalWeightG: 500 });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'bundle.create', actorType: 'ADMIN' }),
      );
    });

    it('audits seller changes without an admin id', async () => {
      (prisma.bundle.findMany as jest.Mock).mockResolvedValue([]);

      await service.create({ ...dto, sellerId: undefined }, seller);

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ actorType: 'SELLER', actorId: null }),
      );
    });

    it('needs an approved seller', async () => {
      await expect(service.create({ ...dto, sellerId: undefined }, admin)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      await expect(service.create({ ...dto, sellerId: 'other' }, seller)).rejects.toBeInstanceOf(
        ForbiddenException,
      );

      (prisma.seller.findUnique as jest.Mock).mockResolvedValue({
        status: SellerStatus.SUSPENDED,
      });
      await expect(service.create(dto, admin)).rejects.toBeInstanceOf(BadRequestException);

      (prisma.seller.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(service.create(dto, admin)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('validates the components', async () => {
      await expect(
        service.create(
          {
            ...dto,
            items: [
              { productVariantId: 'v1', quantity: 1 },
              { productVariantId: 'v1', quantity: 1 },
            ],
          },
          admin,
        ),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);

      (prisma.productVariant.findMany as jest.Mock).mockResolvedValue([]);
      await expect(service.create(dto, admin)).rejects.toBeInstanceOf(NotFoundException);

      (prisma.productVariant.findMany as jest.Mock).mockResolvedValue([
        { id: 'v1', active: false, product: { active: true, sellerId: 'seller-1' } },
      ]);
      await expect(service.create(dto, admin)).rejects.toBeInstanceOf(BadRequestException);

      (prisma.productVariant.findMany as jest.Mock).mockResolvedValue([
        { id: 'v1', active: true, product: { active: true, sellerId: 'someone-else' } },
      ]);
      await expect(service.create({ ...dto, sellerId: undefined }, seller)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('maps a duplicate slug to a conflict', async () => {
      (prisma.bundle.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.bundle.create as jest.Mock).mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('duplicate', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );
      await expect(service.create(dto, admin)).rejects.toBeInstanceOf(ConflictException);
    });

    it('replaces the components on update', async () => {
      await service.update(
        'bundle-1',
        { name: 'New', description: 'New text', price: '800.00', items: dto.items },
        admin,
      );

      expect(prisma.bundleItem.deleteMany).toHaveBeenCalledWith({
        where: { bundleId: 'bundle-1' },
      });
      expect(prisma.bundleItem.createMany).toHaveBeenCalled();
      expect((prisma.bundle.update as jest.Mock).mock.calls[0][0].data.totalWeightG).toBe(500);
    });

    it('does nothing when no field changed', async () => {
      await service.update('bundle-1', {}, admin);
      expect(prisma.bundle.update).not.toHaveBeenCalled();
    });

    it('deactivates softly and audits it', async () => {
      await service.deactivate('bundle-1', admin);

      expect((prisma.bundle.update as jest.Mock).mock.calls[0][0].data.active).toBe(false);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'bundle.deactivate' }),
      );
    });

    it('reactivates an inactive box', async () => {
      (prisma.bundle.findUnique as jest.Mock).mockResolvedValue(bundleRow({ active: false }));

      await service.update('bundle-1', { active: true, totalWeightG: 600 }, admin);

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'bundle.reactivate' }),
      );
    });
  });
});
