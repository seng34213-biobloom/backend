import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { UploadsService } from '../uploads/uploads.service';
import { ProductsAdminService } from './products-admin.service';

const admin = { id: 'admin-1', role: Role.ADMIN } as AuthenticatedUser;
const seller = { id: 'seller-1', role: Role.SELLER } as AuthenticatedUser;

const variantDto = {
  sku: 'HONEY-250',
  name: 'Wild Honey 250g',
  size: '250 g',
  price: 1500,
  unitWeightGrams: 320,
};

const productDto = {
  name: 'Wild Honey',
  slug: 'wild-honey',
  description: 'Raw forest honey',
  category: 'honey',
  basePrice: 1500,
  unitWeightGrams: 320,
  variants: [variantDto],
};

const productRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'product-1',
  sellerId: 'seller-1',
  slug: 'wild-honey',
  active: true,
  variants: [{ id: 'variant-1' }],
  ...overrides,
});

const uniqueError = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });

describe('ProductsAdminService', () => {
  let service: ProductsAdminService;
  let prisma: jest.Mocked<PrismaService>;
  let audit: jest.Mocked<AuditService>;

  beforeEach(() => {
    prisma = {
      product: {
        create: jest.fn().mockResolvedValue(productRow()),
        findUnique: jest.fn().mockResolvedValue(productRow()),
        update: jest.fn().mockResolvedValue(productRow()),
      },
      productVariant: {
        create: jest.fn().mockResolvedValue({ id: 'variant-1', sku: variantDto.sku }),
        findUnique: jest.fn().mockResolvedValue({ id: 'variant-1', productId: 'product-1' }),
        update: jest.fn().mockResolvedValue({ id: 'variant-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      productBatch: { groupBy: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn(async (work: (tx: PrismaService) => Promise<unknown>) => work(prisma)),
    } as unknown as jest.Mocked<PrismaService>;
    audit = {
      record: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<AuditService>;
    service = new ProductsAdminService(prisma, audit, {} as UploadsService);
  });

  it('creates the product and initial variants under the authenticated seller', async () => {
    await service.createProduct(productDto, seller);

    expect(prisma.product.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sellerId: seller.id,
          slug: productDto.slug,
          variants: { create: [expect.objectContaining({ sku: variantDto.sku })] },
        }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'SELLER',
        actorId: null,
        action: 'product.create',
        targetId: 'product-1',
        metadata: expect.objectContaining({ sellerId: seller.id }),
      }),
    );
  });

  it('creates an admin-managed product without assigning a seller', async () => {
    await service.createProduct(productDto, admin);

    expect((prisma.product.create as jest.Mock).mock.calls[0][0].data.sellerId).toBeNull();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ actorType: 'ADMIN', actorId: admin.id }),
    );
  });

  it('returns 409 when product or initial variant uniqueness is violated', async () => {
    (prisma.product.create as jest.Mock).mockRejectedValue(uniqueError());

    await expect(service.createProduct(productDto, seller)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('allows sellers to update only products they own', async () => {
    (prisma.product.update as jest.Mock).mockResolvedValue(productRow({ name: 'Updated Honey' }));

    await service.updateProduct('product-1', { name: 'Updated Honey' }, seller);

    expect(prisma.product.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'product-1' }, data: { name: 'Updated Honey' } }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'product.update', targetType: 'Product' }),
    );

    (prisma.product.findUnique as jest.Mock).mockResolvedValue(
      productRow({ sellerId: 'seller-2' }),
    );
    await expect(
      service.updateProduct('product-1', { name: 'No access' }, seller),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns 409 for duplicate product slugs and variant SKUs', async () => {
    (prisma.product.update as jest.Mock).mockRejectedValue(uniqueError());
    await expect(
      service.updateProduct('product-1', { slug: 'existing-slug' }, admin),
    ).rejects.toBeInstanceOf(ConflictException);

    (prisma.product.update as jest.Mock).mockResolvedValue(productRow());
    (prisma.productVariant.create as jest.Mock).mockRejectedValue(uniqueError());
    await expect(service.createVariant('product-1', variantDto, seller)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('rejects a variant that does not belong to the requested product', async () => {
    (prisma.productVariant.findUnique as jest.Mock).mockResolvedValue({
      id: 'variant-2',
      productId: 'other-product',
    });

    await expect(
      service.updateVariant('product-1', 'variant-2', { name: 'Changed' }, seller),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.productVariant.update).not.toHaveBeenCalled();
  });

  it('deactivates products and their variants without deleting historical rows', async () => {
    await service.deactivateProduct('product-1', seller);

    expect(prisma.product.update).toHaveBeenCalledWith({
      where: { id: 'product-1' },
      data: { active: false },
      select: { id: true, active: true },
    });
    expect(prisma.productVariant.updateMany).toHaveBeenCalledWith({
      where: { productId: 'product-1' },
      data: { active: false },
    });
    expect(prisma.productVariant.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ delete: true }) }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'product.deactivate', targetId: 'product-1' }),
    );
  });

  it('deactivates an owned variant and audits the change', async () => {
    await service.deactivateVariant('product-1', 'variant-1', seller);

    expect(prisma.productVariant.update).toHaveBeenCalledWith({
      where: { id: 'variant-1' },
      data: { active: false },
      select: { id: true, active: true },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'product.variant.deactivate',
        targetType: 'ProductVariant',
        targetId: 'variant-1',
      }),
    );
  });
});
