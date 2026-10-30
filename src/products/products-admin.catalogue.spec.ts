import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma, Role, SellerStatus } from '@prisma/client';
import type { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import type { PrismaService } from '../prisma/prisma.service';
import type { UploadsService } from '../uploads/uploads.service';
import { slugify, uniqueSlug } from './catalogue.util';
import { ProductsAdminService } from './products-admin.service';

const admin = { id: 'admin-1', role: Role.ADMIN } as AuthenticatedUser;
const seller = { id: 'seller-1', role: Role.SELLER } as AuthenticatedUser;

const productRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'product-1',
  sellerId: 'seller-1',
  slug: 'jam',
  active: true,
  basePrice: new Prisma.Decimal('400'),
  unitWeightGrams: 250,
  seller: { id: 'seller-1', businessName: 'Amma' },
  images: [],
  variants: [{ id: 'v1', price: new Prisma.Decimal('400'), unitWeightGrams: 250, active: true }],
  ...overrides,
});

describe('ProductsAdminService catalogue views', () => {
  let prisma: jest.Mocked<PrismaService>;
  let uploads: { presignProductImage: jest.Mock; verifyProductImage: jest.Mock };
  let service: ProductsAdminService;

  beforeEach(() => {
    prisma = {
      product: {
        count: jest.fn().mockResolvedValue(1),
        findMany: jest.fn().mockResolvedValue([productRow()]),
        findUnique: jest.fn().mockResolvedValue(productRow()),
        create: jest.fn().mockResolvedValue({ id: 'product-1', variants: [] }),
      },
      productImage: {
        aggregate: jest.fn().mockResolvedValue({ _count: { _all: 1 }, _max: { sortOrder: 0 } }),
        create: jest.fn().mockResolvedValue({ id: 'image-1' }),
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'image-1', productId: 'product-1', url: 'https://x/a.jpg' }),
        delete: jest.fn().mockResolvedValue({ id: 'image-1' }),
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
      seller: { findUnique: jest.fn().mockResolvedValue({ status: SellerStatus.APPROVED }) },
      $transaction: jest.fn((work: Promise<unknown>[]) => Promise.all(work)),
    } as unknown as jest.Mocked<PrismaService>;
    uploads = {
      presignProductImage: jest.fn().mockResolvedValue({ uploadUrl: 'u' }),
      verifyProductImage: jest.fn().mockResolvedValue({ key: 'products/p/a.jpg' }),
    };
    service = new ProductsAdminService(
      prisma,
      { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService,
      uploads as unknown as UploadsService,
    );
  });

  it('adds stock and the console field names to each row', async () => {
    const out = await service.list({ page: 1, pageSize: 20, search: ' jam ' }, admin);

    expect(out.items[0]).toMatchObject({ basePrice: '400.00', unitWeightG: 250 });
    expect(out.items[0].variants[0]).toMatchObject({
      price: '400.00',
      unitWeightG: 250,
      available: 9,
    });
  });

  it('limits sellers to their own products and hides inactive ones by default', async () => {
    await service.list({ page: 1, pageSize: 20, sellerId: 'other' }, seller);

    expect((prisma.product.findMany as jest.Mock).mock.calls[0][0].where).toEqual({
      sellerId: seller.id,
      active: true,
    });
  });

  it('labels in-house products so the editor always has a seller', async () => {
    (prisma.product.findUnique as jest.Mock).mockResolvedValue(
      productRow({ sellerId: null, seller: null }),
    );
    expect((await service.get('product-1', admin)).seller.businessName).toBe('Bio Bloom');
  });

  it('guards product detail', async () => {
    await expect(service.get('product-1', { ...seller, id: 'other' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    (prisma.product.findUnique as jest.Mock).mockResolvedValue(null);
    await expect(service.get('missing', admin)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('generates a free slug and accepts the console weight field', async () => {
    (prisma.product.findMany as jest.Mock).mockResolvedValue([{ slug: 'new-jam' }]);

    await service.createProduct(
      {
        name: 'New Jam',
        description: 'Jam',
        category: 'jam',
        basePrice: 400,
        unitWeightG: 250,
        sellerId: 'seller-1',
        variants: [{ sku: 'S', name: 'N', size: '1', price: 1, unitWeightG: 100 }],
      } as never,
      admin,
    );

    const { data } = (prisma.product.create as jest.Mock).mock.calls[0][0];
    expect(data).toMatchObject({ slug: 'new-jam-2', unitWeightGrams: 250, sellerId: 'seller-1' });
    expect(data.variants.create[0].unitWeightGrams).toBe(100);
  });

  it('only assigns products to approved sellers', async () => {
    const dto = { sellerId: 'seller-1', slug: 'jam', variants: [] } as never;
    (prisma.seller.findUnique as jest.Mock).mockResolvedValue({
      status: SellerStatus.SUSPENDED,
    });
    await expect(service.createProduct(dto, admin)).rejects.toBeInstanceOf(BadRequestException);

    (prisma.seller.findUnique as jest.Mock).mockResolvedValue(null);
    await expect(service.createProduct(dto, admin)).rejects.toBeInstanceOf(NotFoundException);
  });

  describe('images', () => {
    it('presigns only for products the actor manages', async () => {
      const dto = { productId: 'product-1', contentType: 'image/png', sizeBytes: 10 };

      await service.presignImage(dto, admin);

      expect(uploads.presignProductImage).toHaveBeenCalledWith('product-1', 'image/png', 10);
      await expect(service.presignImage(dto, { ...seller, id: 'other' })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('verifies the upload and appends it to the gallery', async () => {
      await service.addImage('product-1', { url: 'https://x/a.jpg' }, admin);

      expect(uploads.verifyProductImage).toHaveBeenCalledWith('https://x/a.jpg');
      expect((prisma.productImage.create as jest.Mock).mock.calls[0][0].data).toMatchObject({
        altText: '',
        sortOrder: 1,
      });
    });

    it('caps the gallery', async () => {
      (prisma.productImage.aggregate as jest.Mock).mockResolvedValue({
        _count: { _all: 10 },
        _max: { sortOrder: 9 },
      });
      await expect(
        service.addImage('product-1', { url: 'https://x/a.jpg' }, admin),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(uploads.verifyProductImage).not.toHaveBeenCalled();
    });

    it('removes only images of that product', async () => {
      await expect(service.removeImage('product-1', 'image-1', admin)).resolves.toEqual({
        id: 'image-1',
        deleted: true,
      });

      (prisma.productImage.findUnique as jest.Mock).mockResolvedValue({
        id: 'image-1',
        productId: 'other',
      });
      await expect(service.removeImage('product-1', 'image-1', admin)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});

describe('catalogue helpers', () => {
  it('slugifies names', () => {
    expect(slugify('Mango & Chilli Jam!')).toBe('mango-and-chilli-jam');
    expect(slugify('!!!')).toBe('item');
  });

  it('finds the first free slug', async () => {
    await expect(uniqueSlug('jam', async () => [])).resolves.toBe('jam');
    await expect(uniqueSlug('jam', async () => ['jam', 'jam-2'])).resolves.toBe('jam-3');
  });
});
