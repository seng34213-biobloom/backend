import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DiscountType } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import type { CreatePromoCodeDto, UpdatePromoCodeDto } from './dto/promo-code.dto';

/**
 * SDS §6.3 discount codes managed from the admin console. PERCENTAGE values
 * are percents (10 = 10 %); FIXED values are LKR.
 */
@Injectable()
export class PromoCodesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  normalise(code: string): string {
    return code.trim().toUpperCase();
  }

  list() {
    return this.prisma.promoCode.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async create(dto: CreatePromoCodeDto, actor: AuthenticatedUser) {
    this.assertValue(dto.discountType, dto.discountValue);
    this.assertWindow(new Date(dto.validFrom), new Date(dto.validUntil));
    try {
      const created = await this.prisma.promoCode.create({
        data: {
          code: this.normalise(dto.code),
          description: dto.description,
          discountType: dto.discountType,
          discountValue: dto.discountValue,
          minOrderLkr: dto.minOrderLkr,
          validFrom: new Date(dto.validFrom),
          validUntil: new Date(dto.validUntil),
          maxUses: dto.maxUses,
          active: dto.active ?? true,
        },
      });
      await this.record(actor, 'promo.create', created.id, { code: created.code });
      return created;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(`Promo code ${this.normalise(dto.code)} already exists`);
      }
      throw e;
    }
  }

  async update(id: string, dto: UpdatePromoCodeDto, actor: AuthenticatedUser) {
    const existing = await this.prisma.promoCode.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Promo code ${id} not found`);
    const type = dto.discountType ?? (existing.discountType as DiscountType);
    const value = dto.discountValue ?? existing.discountValue.toString();
    this.assertValue(type, value);
    const from = dto.validFrom ? new Date(dto.validFrom) : existing.validFrom;
    const until = dto.validUntil ? new Date(dto.validUntil) : existing.validUntil;
    this.assertWindow(from, until);
    if (dto.maxUses !== undefined && dto.maxUses !== null && dto.maxUses < existing.usedCount) {
      throw new UnprocessableEntityException(
        `maxUses cannot be below the ${existing.usedCount} uses already made`,
      );
    }
    const updated = await this.prisma.promoCode.update({
      where: { id },
      data: {
        description: dto.description,
        discountType: dto.discountType,
        discountValue: dto.discountValue,
        minOrderLkr: dto.minOrderLkr,
        validFrom: dto.validFrom ? from : undefined,
        validUntil: dto.validUntil ? until : undefined,
        maxUses: dto.maxUses,
        active: dto.active,
      },
    });
    await this.record(actor, 'promo.update', id, { changes: { ...dto } });
    return updated;
  }

  private assertValue(type: DiscountType, value: string): void {
    const v = new Prisma.Decimal(value);
    if (v.lte(0)) throw new UnprocessableEntityException('discountValue must be greater than 0');
    if (type === DiscountType.PERCENTAGE && v.gt(100)) {
      throw new UnprocessableEntityException('A percentage discount cannot exceed 100');
    }
  }

  private assertWindow(from: Date, until: Date): void {
    if (until <= from) throw new UnprocessableEntityException('validUntil must be after validFrom');
  }

  private record(
    actor: AuthenticatedUser,
    action: string,
    targetId: string,
    metadata: Record<string, unknown>,
  ) {
    return this.audit.record({
      actorType: 'ADMIN',
      actorId: actor.id,
      action,
      targetType: 'PromoCode',
      targetId,
      metadata,
    });
  }
}
