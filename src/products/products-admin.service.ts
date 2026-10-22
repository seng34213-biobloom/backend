import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AuditActorType, Prisma, Role } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateProductDto } from './dto/create-product.dto';
import type { CreateVariantDto } from './dto/create-variant.dto';
import type { UpdateProductDto } from './dto/update-product.dto';
import type { UpdateVariantDto } from './dto/update-variant.dto';

const productWithVariants = {
  id: true,
  sellerId: true,
  slug: true,
  name: true,
  description: true,
  category: true,
  basePrice: true,
  unitWeightGrams: true,
  active: true,
  variants: {
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

@Injectable()
export class ProductsAdminService {
  private readonly logger = new Logger(ProductsAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async createProduct(dto: CreateProductDto, actor: AuthenticatedUser) {
    const sellerId = actor.role === Role.SELLER ? actor.id : null;
    let product;
    try {
      product = await this.prisma.product.create({
        data: {
          sellerId,
          name: dto.name,
          slug: dto.slug,
          description: dto.description,
          category: dto.category,
          basePrice: dto.basePrice,
          unitWeightGrams: dto.unitWeightGrams,
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
    return product;
  }

  async updateProduct(productId: string, dto: UpdateProductDto, actor: AuthenticatedUser) {
    const product = await this.requireProduct(productId, actor);
    try {
      const updated = await this.prisma.product.update({
        where: { id: product.id },
        data: dto,
        select: productWithVariants,
      });
      await this.recordMutation(actor, 'product.update', 'Product', updated.id, {
        fields: Object.keys(dto),
      });
      return updated;
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

    try {
      const updated = await this.prisma.productVariant.update({
        where: { id: variant.id },
        data: dto,
      });
      await this.recordMutation(actor, 'product.variant.update', 'ProductVariant', updated.id, {
        productId: product.id,
        fields: Object.keys(dto),
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
      unitWeightGrams: dto.unitWeightGrams,
    };
  }

  private throwIfUniqueConflict(error: unknown, message: string): void {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ConflictException(message);
    }
  }
}
