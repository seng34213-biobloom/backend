import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AuditActorType, Prisma, Role, SellerStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { UploadsService } from '../uploads/uploads.service';
import { money, slugify, stockByVariant, uniqueSlug, type VariantStock } from './catalogue.util';
import type { CreateProductDto } from './dto/create-product.dto';
import type { CreateVariantDto } from './dto/create-variant.dto';
import type { ListAdminProductsQueryDto } from './dto/list-admin-products-query.dto';
import type { AddProductImageDto, PresignProductImageDto } from './dto/product-image.dto';
import type { UpdateProductDto } from './dto/update-product.dto';
import type { UpdateVariantDto } from './dto/update-variant.dto';

/** Gallery cap per product (SDS §6.2 thumbnail strip). */
const MAX_PRODUCT_IMAGES = 10;

const productWithVariants = {
  id: true,
  sellerId: true,
  slug: true,
  name: true,
  description: true,
  category: true,
  basePrice: true,
  unitWeightGrams: true,
  ingredients: true,
  allergens: true,
  active: true,
  seller: { select: { id: true, businessName: true } },
  images: {
    orderBy: [{ sortOrder: 'asc' as const }, { createdAt: 'asc' as const }],
    select: { id: true, url: true, altText: true, sortOrder: true },
  },
  variants: {
    orderBy: [{ unitWeightGrams: 'asc' as const }, { createdAt: 'asc' as const }],
    select: {
      id: true,
      sku: true,
      name: true,
      size: true,
      price: true,
      unitWeightGrams: true,
      active: true,
    },
  },
} satisfies Prisma.ProductSelect;

type ProductRow = Prisma.ProductGetPayload<{ select: typeof productWithVariants }>;

/** Products managed directly by Bio Bloom have no seller row. */
const HOUSE_SELLER = { id: '', businessName: 'Bio Bloom' };

@Injectable()
export class ProductsAdminService {
  private readonly logger = new Logger(ProductsAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly uploads: UploadsService,
  ) {}

  async list(query: ListAdminProductsQueryDto, actor: AuthenticatedUser) {
    const search = query.search?.trim();
    const sellerId = actor.role === Role.SELLER ? actor.id : query.sellerId;
    const where: Prisma.ProductWhereInput = {
      ...(sellerId ? { sellerId } : {}),
      ...(query.includeInactive ? {} : { active: true }),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' as const } },
              { slug: { contains: search, mode: 'insensitive' as const } },
              { variants: { some: { sku: { contains: search, mode: 'insensitive' as const } } } },
            ],
          }
        : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.product.count({ where }),
      this.prisma.product.findMany({
        where,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: productWithVariants,
      }),
    ]);
    const stock = await stockByVariant(
      this.prisma,
      rows.flatMap((row) => row.variants.map((variant) => variant.id)),
    );
    return {
      items: rows.map((row) => this.toView(row, stock)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async get(productId: string, actor: AuthenticatedUser) {
    const row = await this.prisma.product.findUnique({
      where: { id: productId },
      select: productWithVariants,
    });
    if (!row) throw new NotFoundException(`Product ${productId} not found`);
    if (actor.role === Role.SELLER && row.sellerId !== actor.id) {
      throw new ForbiddenException('Sellers can only manage their own products');
    }
    const stock = await stockByVariant(
      this.prisma,
      row.variants.map((variant) => variant.id),
    );
    return this.toView(row, stock);
  }

  async presignImage(dto: PresignProductImageDto, actor: AuthenticatedUser) {
    await this.requireProduct(dto.productId, actor);
    return this.uploads.presignProductImage(dto.productId, dto.contentType, dto.sizeBytes);
  }

  async addImage(productId: string, dto: AddProductImageDto, actor: AuthenticatedUser) {
    await this.requireProduct(productId, actor);
    const last = await this.prisma.productImage.aggregate({
      where: { productId },
      _count: { _all: true },
      _max: { sortOrder: true },
    });
    if (last._count._all >= MAX_PRODUCT_IMAGES) {
      throw new BadRequestException(`A product can have at most ${MAX_PRODUCT_IMAGES} images`);
    }
    // SDS §7.4: size cap, magic-byte check and bucket ownership before the URL is stored.
    const { key } = await this.uploads.verifyProductImage(dto.url);
    const image = await this.prisma.productImage.create({
      data: {
        productId,
        url: dto.url,
        altText: dto.altText ?? '',
        sortOrder: (last._max.sortOrder ?? -1) + 1,
      },
      select: { id: true, url: true, altText: true, sortOrder: true },
    });
    await this.recordMutation(actor, 'product.image.add', 'ProductImage', image.id, {
      productId,
      key,
    });
    return image;
  }

  async removeImage(productId: string, imageId: string, actor: AuthenticatedUser) {
    await this.requireProduct(productId, actor);
    const image = await this.prisma.productImage.findUnique({
      where: { id: imageId },
      select: { id: true, productId: true, url: true },
    });
    if (!image || image.productId !== productId) {
      throw new NotFoundException(`Image ${imageId} not found under product ${productId}`);
    }
    await this.prisma.productImage.delete({ where: { id: imageId } });
    await this.recordMutation(actor, 'product.image.remove', 'ProductImage', imageId, {
      productId,
      url: image.url,
    });
    return { id: imageId, deleted: true };
  }

  async createProduct(dto: CreateProductDto, actor: AuthenticatedUser) {
    const sellerId = await this.resolveSeller(dto.sellerId, actor);
    const slug =
      dto.slug ??
      (await uniqueSlug(slugify(dto.name), async (prefix) =>
        (
          await this.prisma.product.findMany({
            where: { slug: { startsWith: prefix } },
            select: { slug: true },
          })
        ).map((row) => row.slug),
      ));
    let product;
    try {
      product = await this.prisma.product.create({
        data: {
          sellerId,
          name: dto.name,
          slug,
          description: dto.description,
          category: dto.category,
          basePrice: dto.basePrice,
          unitWeightGrams: (dto.unitWeightGrams ?? dto.unitWeightG) as number,
          ingredients: dto.ingredients ?? null,
          allergens: dto.allergens ?? null,
          variants: {
            create: dto.variants.map((variant) => this.variantData(variant)),
          },
        },
        select: productWithVariants,
      });
    } catch (error) {
      this.throwIfUniqueConflict(error, 'Product slug or variant SKU already exists');
      throw error;
    }

    await this.recordMutation(actor, 'product.create', 'Product', product.id, {
      slug: product.slug,
      variantIds: product.variants.map((variant) => variant.id),
    });
    this.logger.log(`Product ${product.id} created by ${actor.role} ${actor.id}`);
    return this.get(product.id, actor);
  }

  async updateProduct(productId: string, dto: UpdateProductDto, actor: AuthenticatedUser) {
    const product = await this.requireProduct(productId, actor);
    const data = this.withoutWeightAlias(dto);
    try {
      const updated = await this.prisma.product.update({
        where: { id: product.id },
        data,
        select: { id: true },
      });
      await this.recordMutation(actor, 'product.update', 'Product', updated.id, {
        fields: Object.keys(data),
      });
      return await this.get(updated.id, actor);
    } catch (error) {
      this.throwIfUniqueConflict(error, 'Product slug already exists');
      throw error;
    }
  }

  async createVariant(productId: string, dto: CreateVariantDto, actor: AuthenticatedUser) {
    const product = await this.requireProduct(productId, actor);
    if (!product.active) throw new ConflictException('Cannot add a variant to an inactive product');

    try {
      const variant = await this.prisma.productVariant.create({
        data: { ...this.variantData(dto), productId: product.id },
      });
      await this.recordMutation(actor, 'product.variant.create', 'ProductVariant', variant.id, {
        productId: product.id,
        sku: variant.sku,
      });
      return variant;
    } catch (error) {
      this.throwIfUniqueConflict(error, 'Variant SKU already exists');
      throw error;
    }
  }

  async updateVariant(
    productId: string,
    variantId: string,
    dto: UpdateVariantDto,
    actor: AuthenticatedUser,
  ) {
    const product = await this.requireProduct(productId, actor);
    const variant = await this.prisma.productVariant.findUnique({
      where: { id: variantId },
      select: { id: true, productId: true },
    });
    if (!variant || variant.productId !== product.id) {
      throw new NotFoundException(`Variant ${variantId} not found under product ${productId}`);
    }

    const data = this.withoutWeightAlias(dto);
    try {
      const updated = await this.prisma.productVariant.update({
        where: { id: variant.id },
        data,
      });
      await this.recordMutation(actor, 'product.variant.update', 'ProductVariant', updated.id, {
        productId: product.id,
        fields: Object.keys(data),
      });
      return updated;
    } catch (error) {
      this.throwIfUniqueConflict(error, 'Variant SKU already exists');
      throw error;
    }
  }

  async deactivateProduct(productId: string, actor: AuthenticatedUser) {
    const product = await this.requireProduct(productId, actor);
    const updated = await this.prisma.$transaction(async (tx) => {
      const deactivated = await tx.product.update({
        where: { id: product.id },
        data: { active: false },
        select: { id: true, active: true },
      });
      await tx.productVariant.updateMany({
        where: { productId: product.id },
        data: { active: false },
      });
      return deactivated;
    });
    await this.recordMutation(actor, 'product.deactivate', 'Product', updated.id);
    return updated;
  }

  async deactivateVariant(productId: string, variantId: string, actor: AuthenticatedUser) {
    const product = await this.requireProduct(productId, actor);
    const variant = await this.prisma.productVariant.findUnique({
      where: { id: variantId },
      select: { id: true, productId: true },
    });
    if (!variant || variant.productId !== product.id) {
      throw new NotFoundException(`Variant ${variantId} not found under product ${productId}`);
    }
    const updated = await this.prisma.productVariant.update({
      where: { id: variant.id },
      data: { active: false },
      select: { id: true, active: true },
    });
    await this.recordMutation(actor, 'product.variant.deactivate', 'ProductVariant', updated.id, {
      productId: product.id,
    });
    return updated;
  }

  /** Sellers own what they create; admins pick an approved seller or keep it in-house. */
  private async resolveSeller(requested: string | undefined, actor: AuthenticatedUser) {
    if (actor.role === Role.SELLER) return actor.id;
    if (!requested) return null;
    const seller = await this.prisma.seller.findUnique({
      where: { id: requested },
      select: { status: true },
    });
    if (!seller) throw new NotFoundException(`Seller ${requested} not found`);
    if (seller.status !== SellerStatus.APPROVED) {
      throw new BadRequestException(`Seller ${requested} is ${seller.status}, not APPROVED`);
    }
    return requested;
  }

  private withoutWeightAlias<T extends { unitWeightG?: number; unitWeightGrams?: number }>(dto: T) {
    const data = { ...dto, unitWeightGrams: dto.unitWeightGrams ?? dto.unitWeightG };
    delete data.unitWeightG;
    if (data.unitWeightGrams === undefined) delete data.unitWeightGrams;
    return data;
  }

  private toView(row: ProductRow, stock: Map<string, VariantStock>) {
    return {
      ...row,
      basePrice: money(row.basePrice),
      unitWeightG: row.unitWeightGrams,
      seller: row.seller ?? HOUSE_SELLER,
      variants: row.variants.map((variant) => ({
        ...variant,
        price: money(variant.price),
        unitWeightG: variant.unitWeightGrams,
        available: stock.get(variant.id)?.available ?? 0,
        earliestExpiry: stock.get(variant.id)?.earliestExpiry ?? null,
      })),
    };
  }

  private async requireProduct(productId: string, actor: AuthenticatedUser) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, sellerId: true, slug: true, active: true },
    });
    if (!product) throw new NotFoundException(`Product ${productId} not found`);
    if (actor.role === Role.SELLER && product.sellerId !== actor.id) {
      throw new ForbiddenException('Sellers can only manage their own products');
    }
    return product;
  }

  private async recordMutation(
    actor: AuthenticatedUser,
    action: string,
    targetType: string,
    targetId: string,
    metadata?: Record<string, unknown>,
  ) {
    const isSeller = actor.role === Role.SELLER;
    await this.audit.record({
      actorType: isSeller ? AuditActorType.SELLER : AuditActorType.ADMIN,
      actorId: isSeller ? null : actor.id,
      action,
      targetType,
      targetId,
      metadata: { ...(isSeller ? { sellerId: actor.id } : {}), ...metadata },
    });
  }

  private variantData(dto: CreateVariantDto) {
    return {
      sku: dto.sku,
      name: dto.name,
      size: dto.size,
      price: dto.price,
      unitWeightGrams: (dto.unitWeightGrams ?? dto.unitWeightG) as number,
    };
  }

  private throwIfUniqueConflict(error: unknown, message: string): void {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ConflictException(message);
    }
  }
}
