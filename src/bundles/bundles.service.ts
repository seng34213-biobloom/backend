import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AuditActorType, Prisma, Role, SellerStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import {
  money,
  slugify,
  stockByVariant,
  uniqueSlug,
  type VariantStock,
} from '../products/catalogue.util';
import type {
  BundleComponentDto,
  CreateBundleDto,
  ListAdminBundlesQueryDto,
  ListBundlesQueryDto,
  UpdateBundleDto,
} from './dto/bundle.dto';

const bundleInclude = {
  seller: { select: { id: true, businessName: true, status: true } },
  items: {
    orderBy: { id: 'asc' as const },
    include: {
      variant: {
        include: {
          product: {
            select: {
              id: true,
              name: true,
              slug: true,
              active: true,
              seller: { select: { status: true } },
              images: {
                orderBy: [{ sortOrder: 'asc' as const }, { createdAt: 'asc' as const }],
                take: 1,
                select: { url: true },
              },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.BundleInclude;

type BundleRow = Prisma.BundleGetPayload<{ include: typeof bundleInclude }>;

export interface BundleComponentView {
  productVariantId: string;
  quantity: number;
  sku: string;
  variantName: string;
  size: string;
  price: string;
  unitWeightG: number;
  product: { id: string; name: string; slug: string };
  /** Valid stock of the component variant (FIFO predicate). */
  available: number;
  /** Variant and product active, product seller approved. */
  purchasable: boolean;
}

export interface BundleView {
  id: string;
  slug: string;
  name: string;
  description: string;
  price: string;
  /** Sum of the components bought separately, for the "save" label. */
  componentsTotal: string;
  totalWeightG: number;
  imageUrl: string | null;
  seller: { id: string; businessName: string };
  /** Whole boxes that can be assembled: min over components of floor(stock / qty). */
  available: number;
  components: BundleComponentView[];
}

export interface AdminBundleView extends BundleView {
  active: boolean;
  sellerStatus: SellerStatus;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Gift boxes (SDS §1.2, §6.1 "Gift Boxes" category). A bundle is a fixed
 * set of variants sold at one price and shipped at `totalWeightG`. It is
 * purchasable only while it is active, its seller is APPROVED and every
 * component variant and product is active; how many boxes are available is
 * the minimum over components of floor(valid stock / quantity per box).
 */
@Injectable()
export class BundlesService {
  private readonly logger = new Logger(BundlesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ----- public ----------------------------------------------------------------

  /** Purchasable bundles with at least one box in stock, by name. */
  async listPublic(
    query: ListBundlesQueryDto,
  ): Promise<{ items: BundleView[]; total: number; page: number; pageSize: number }> {
    const rows = await this.prisma.bundle.findMany({
      where: { active: true, seller: { status: SellerStatus.APPROVED } },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      include: bundleInclude,
    });
    const stock = await this.stockFor(rows);
    // Availability depends on live batch stock, so the page is cut after
    // filtering. Gift boxes are a short list; this stays cheap.
    const sellable = rows.map((r) => this.toView(r, stock)).filter((b) => b.available > 0);
    const start = (query.page - 1) * query.pageSize;
    return {
      items: sellable.slice(start, start + query.pageSize),
      total: sellable.length,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async getPublic(slug: string): Promise<BundleView> {
    const row = await this.prisma.bundle.findFirst({
      where: { slug, active: true, seller: { status: SellerStatus.APPROVED } },
      include: bundleInclude,
    });
    if (!row) throw new NotFoundException(`Bundle ${slug} not found`);
    return this.toView(row, await this.stockFor([row]));
  }

  // ----- admin / seller --------------------------------------------------------

  async listAdmin(
    query: ListAdminBundlesQueryDto,
    actor: AuthenticatedUser,
  ): Promise<{ items: AdminBundleView[]; total: number; page: number; pageSize: number }> {
    const where: Prisma.BundleWhereInput = {
      ...(actor.role === Role.SELLER ? { sellerId: actor.id } : {}),
      ...(query.includeInactive ? {} : { active: true }),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.bundle.count({ where }),
      this.prisma.bundle.findMany({
        where,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: bundleInclude,
      }),
    ]);
    const stock = await this.stockFor(rows);
    return {
      items: rows.map((r) => this.toAdminView(r, stock)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async getAdmin(bundleId: string, actor: AuthenticatedUser): Promise<AdminBundleView> {
    const row = await this.prisma.bundle.findUnique({
      where: { id: bundleId },
      include: bundleInclude,
    });
    if (!row) throw new NotFoundException(`Bundle ${bundleId} not found`);
    this.assertOwner(row.sellerId, actor);
    return this.toAdminView(row, await this.stockFor([row]));
  }

  async create(dto: CreateBundleDto, actor: AuthenticatedUser): Promise<AdminBundleView> {
    const sellerId = await this.resolveSeller(dto.sellerId, actor);
    const components = await this.validateComponents(dto.items, actor);
    const totalWeightG =
      dto.totalWeightG ??
      dto.items.reduce(
        (acc, it) => acc + (components.get(it.productVariantId) ?? 0) * it.quantity,
        0,
      );

    const slug = await uniqueSlug(slugify(dto.name), async (prefix) =>
      (
        await this.prisma.bundle.findMany({
          where: { slug: { startsWith: prefix } },
          select: { slug: true },
        })
      ).map((b) => b.slug),
    );

    let created: { id: string };
    try {
      created = await this.prisma.bundle.create({
        data: {
          sellerId,
          slug,
          name: dto.name,
          description: dto.description,
          price: new Prisma.Decimal(dto.price),
          totalWeightG,
          active: true,
          items: {
            create: dto.items.map((it) => ({
              productVariantId: it.productVariantId,
              quantity: it.quantity,
            })),
          },
        },
        select: { id: true },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('A bundle with this slug already exists');
      }
      throw e;
    }

    await this.audit.record({
      ...this.auditActor(actor),
      action: 'bundle.create',
      targetType: 'Bundle',
      targetId: created.id,
      metadata: {
        sellerId,
        slug,
        price: money(dto.price),
        totalWeightG,
        items: dto.items.map((it) => ({
          productVariantId: it.productVariantId,
          quantity: it.quantity,
        })),
      },
    });
    this.logger.log(`Bundle ${created.id} (${slug}) created by ${actor.role} ${actor.id}`);
    return this.getAdmin(created.id, actor);
  }

  async update(
    bundleId: string,
    dto: UpdateBundleDto,
    actor: AuthenticatedUser,
  ): Promise<AdminBundleView> {
    const bundle = await this.prisma.bundle.findUnique({
      where: { id: bundleId },
      select: { id: true, sellerId: true, active: true },
    });
    if (!bundle) throw new NotFoundException(`Bundle ${bundleId} not found`);
    this.assertOwner(bundle.sellerId, actor);

    const data: Prisma.BundleUpdateInput = {};
    const changed: string[] = [];
    if (dto.name !== undefined) {
      data.name = dto.name;
      changed.push('name');
    }
    if (dto.description !== undefined) {
      data.description = dto.description;
      changed.push('description');
    }
    if (dto.price !== undefined) {
      data.price = new Prisma.Decimal(dto.price);
      changed.push('price');
    }
    if (dto.items !== undefined) {
      const components = await this.validateComponents(dto.items, actor);
      changed.push('items');
      if (dto.totalWeightG === undefined) {
        data.totalWeightG = dto.items.reduce(
          (acc, it) => acc + (components.get(it.productVariantId) ?? 0) * it.quantity,
          0,
        );
      }
    }
    if (dto.totalWeightG !== undefined) {
      data.totalWeightG = dto.totalWeightG;
      changed.push('totalWeightG');
    }
    const deactivating = dto.active === false && bundle.active;
    const reactivating = dto.active === true && !bundle.active;
    if (deactivating || reactivating) {
      data.active = dto.active;
      changed.push('active');
    }
    if (changed.length === 0) return this.getAdmin(bundleId, actor);

    await this.prisma.$transaction(async (tx) => {
      await tx.bundle.update({ where: { id: bundleId }, data });
      if (dto.items !== undefined) {
        await tx.bundleItem.deleteMany({ where: { bundleId } });
        await tx.bundleItem.createMany({
          data: dto.items.map((it) => ({
            bundleId,
            productVariantId: it.productVariantId,
            quantity: it.quantity,
          })),
        });
      }
    });

    await this.audit.record({
      ...this.auditActor(actor),
      action: deactivating
        ? 'bundle.deactivate'
        : reactivating
          ? 'bundle.reactivate'
          : 'bundle.update',
      targetType: 'Bundle',
      targetId: bundleId,
      metadata: {
        changed,
        ...(dto.price !== undefined ? { price: money(dto.price) } : {}),
        ...(dto.items !== undefined
          ? {
              items: dto.items.map((it) => ({
                productVariantId: it.productVariantId,
                quantity: it.quantity,
              })),
            }
          : {}),
      },
    });
    return this.getAdmin(bundleId, actor);
  }

  /** `DELETE /api/admin/bundles/:id` — soft deactivation. */
  async deactivate(bundleId: string, actor: AuthenticatedUser): Promise<AdminBundleView> {
    return this.update(bundleId, { active: false }, actor);
  }

  // ----- helpers ---------------------------------------------------------------

  private auditActor(actor: AuthenticatedUser) {
    return actor.role === Role.SELLER
      ? { actorType: AuditActorType.SELLER, actorId: null }
      : { actorType: AuditActorType.ADMIN, actorId: actor.id };
  }

  private assertOwner(sellerId: string, actor: AuthenticatedUser): void {
    if (actor.role === Role.SELLER && sellerId !== actor.id) {
      throw new ForbiddenException('Sellers can only manage their own bundles');
    }
  }

  private async resolveSeller(
    requested: string | undefined,
    actor: AuthenticatedUser,
  ): Promise<string> {
    if (actor.role === Role.SELLER) {
      if (requested && requested !== actor.id) {
        throw new ForbiddenException('Sellers can only create bundles for themselves');
      }
      return actor.id;
    }
    if (!requested) {
      throw new UnprocessableEntityException('sellerId is required when an admin creates a bundle');
    }
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

  /**
   * Components must be distinct, existing, active variants. A seller may
   * only box their own products. Returns unit weight per variant id.
   */
  private async validateComponents(
    items: BundleComponentDto[],
    actor: AuthenticatedUser,
  ): Promise<Map<string, number>> {
    const ids = items.map((it) => it.productVariantId);
    if (new Set(ids).size !== ids.length) {
      throw new UnprocessableEntityException('Each variant may appear only once in a bundle');
    }
    const variants = await this.prisma.productVariant.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        active: true,
        unitWeightGrams: true,
        product: { select: { active: true, sellerId: true } },
      },
    });
    const byId = new Map(variants.map((v) => [v.id, v]));
    for (const id of ids) {
      const v = byId.get(id);
      if (!v) throw new NotFoundException(`Variant ${id} not found`);
      if (!v.active || !v.product.active) {
        throw new BadRequestException(`Variant ${id} is inactive and cannot be bundled`);
      }
      if (actor.role === Role.SELLER && v.product.sellerId !== actor.id) {
        throw new ForbiddenException('Sellers can only bundle their own products');
      }
    }
    return new Map(variants.map((v) => [v.id, v.unitWeightGrams]));
  }

  private stockFor(rows: BundleRow[]): Promise<Map<string, VariantStock>> {
    return stockByVariant(
      this.prisma,
      rows.flatMap((r) => r.items.map((it) => it.productVariantId)),
    );
  }

  private toView(row: BundleRow, stock: Map<string, VariantStock>): BundleView {
    let componentsTotal = new Prisma.Decimal(0);
    let available = row.items.length > 0 ? Number.MAX_SAFE_INTEGER : 0;
    const components: BundleComponentView[] = row.items.map((it) => {
      const v = it.variant;
      const purchasable =
        v.active &&
        v.product.active &&
        (!v.product.seller || v.product.seller.status === SellerStatus.APPROVED);
      const variantStock = stock.get(v.id)?.available ?? 0;
      componentsTotal = componentsTotal.plus(new Prisma.Decimal(v.price).times(it.quantity));
      available = Math.min(available, purchasable ? Math.floor(variantStock / it.quantity) : 0);
      return {
        productVariantId: v.id,
        quantity: it.quantity,
        sku: v.sku,
        variantName: v.name,
        size: v.size,
        price: money(v.price),
        unitWeightG: v.unitWeightGrams,
        product: { id: v.product.id, name: v.product.name, slug: v.product.slug },
        available: variantStock,
        purchasable,
      };
    });
    const sellerApproved = row.seller.status === SellerStatus.APPROVED;
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      price: money(row.price),
      componentsTotal: componentsTotal.toFixed(2),
      totalWeightG: row.totalWeightG,
      imageUrl:
        row.items.find((it) => it.variant.product.images.length > 0)?.variant.product.images[0]
          .url ?? null,
      seller: { id: row.seller.id, businessName: row.seller.businessName },
      available: row.active && sellerApproved ? available : 0,
      components,
    };
  }

  private toAdminView(row: BundleRow, stock: Map<string, VariantStock>): AdminBundleView {
    return {
      ...this.toView(row, stock),
      active: row.active,
      sellerStatus: row.seller.status as SellerStatus,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
