import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { BatchStatus, Prisma, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import type { CreateBatchDto } from './dto/create-batch.dto';

function startOfTodayUtc(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

@Injectable()
export class BatchesService {
  private readonly logger = new Logger(BatchesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Create a batch tied to a ProductVariant. ADMIN can create for any
   * product. SELLER can create only for products they own. Manufacturing
   * date must be <= today; expiry must be > today.
   */
  async createForVariant(
    productId: string,
    variantId: string,
    dto: CreateBatchDto,
    actor: AuthenticatedUser,
  ): Promise<{
    id: string;
    batchNumber: string;
    manufacturedDate: Date;
    expiryDate: Date;
    initialQuantity: number;
    currentQuantity: number;
    status: BatchStatus;
  }> {
    const today = startOfTodayUtc();
    const mfg = new Date(dto.manufacturedDate);
    const exp = new Date(dto.expiryDate);
    if (Number.isNaN(mfg.getTime()) || Number.isNaN(exp.getTime())) {
      throw new BadRequestException('Invalid date');
    }
    if (mfg > today) {
      throw new BadRequestException('manufacturedDate cannot be in the future');
    }
    if (exp <= today) {
      throw new BadRequestException('expiryDate must be in the future');
    }
    if (exp <= mfg) {
      throw new BadRequestException('expiryDate must be after manufacturedDate');
    }

    const variant = await this.prisma.productVariant.findUnique({
      where: { id: variantId },
      include: { product: { select: { id: true, sellerId: true } } },
    });
    if (!variant || variant.productId !== productId) {
      throw new NotFoundException(`Variant ${variantId} not found under product ${productId}`);
    }
    if (actor.role === Role.SELLER && variant.product.sellerId !== actor.id) {
      throw new ForbiddenException('Sellers can only create batches for their own products');
    }

    const batchNumber = dto.batchNumber.trim();
    let created;
    try {
      created = await this.prisma.productBatch.create({
        data: {
          productVariantId: variantId,
          batchNumber,
          manufacturedDate: mfg,
          expiryDate: exp,
          initialQuantity: dto.initialQuantity,
          currentQuantity: dto.initialQuantity,
          status: BatchStatus.ACTIVE,
        },
      });
    } catch (e) {
      // Unique (product_variant_id, batch_number)
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(`Batch ${batchNumber} already exists for this variant`);
      }
      throw e;
    }

    // audit_log.actor_id only references admin users, so a seller's ID goes in metadata
    const isSeller = actor.role === Role.SELLER;
    await this.audit.record({
      actorType: isSeller ? 'SELLER' : 'ADMIN',
      actorId: isSeller ? null : actor.id,
      action: 'batch.create',
      targetType: 'ProductBatch',
      targetId: created.id,
      metadata: {
        ...(isSeller ? { sellerId: actor.id } : {}),
        productId,
        variantId,
        batchNumber: created.batchNumber,
        initialQuantity: created.initialQuantity,
      },
    });

    this.logger.log(
      `Batch ${created.id} created variant=${variantId} qty=${created.initialQuantity}`,
    );
    return {
      id: created.id,
      batchNumber: created.batchNumber,
      manufacturedDate: created.manufacturedDate,
      expiryDate: created.expiryDate,
      initialQuantity: created.initialQuantity,
      currentQuantity: created.currentQuantity,
      status: created.status,
    };
  }

  /**
   * Admin/seller batch screen list. Returns batches across all variants of
   * a product, sorted earliest-expiry first per wireframe §6.6.
   */
  async listForProduct(productId: string, actor: AuthenticatedUser) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, sellerId: true, name: true },
    });
    if (!product) throw new NotFoundException(`Product ${productId} not found`);
    if (actor.role === Role.SELLER && product.sellerId !== actor.id) {
      throw new ForbiddenException('Sellers can only view batches for their own products');
    }

    return this.prisma.productBatch.findMany({
      where: { variant: { productId } },
      orderBy: [{ expiryDate: 'asc' }, { batchNumber: 'asc' }],
      include: {
        variant: { select: { id: true, sku: true, size: true, name: true } },
      },
    });
  }
}
