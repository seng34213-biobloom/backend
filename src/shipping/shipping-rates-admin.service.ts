import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { ShippingService } from './shipping.service';
import type { CreateShippingRateDto, UpdateShippingRateDto } from './dto/shipping-rate.dto';

export interface Bracket {
  id?: string;
  minWeightG: number;
  maxWeightG: number;
}

/**
 * DDP-#16 — brackets must start at 0 g and be contiguous with no gaps or
 * overlaps (each `min` is the previous `max + 1`); a gap would make checkout
 * fail with 404 for weights that fall into it. Returns the problem, or null.
 */
export function bracketProblem(brackets: Bracket[]): string | null {
  if (brackets.length === 0) return 'At least one shipping bracket is required';
  const sorted = [...brackets].sort((a, b) => a.minWeightG - b.minWeightG);
  if (sorted[0].minWeightG !== 0) return 'The first bracket must start at 0 g';
  for (let i = 0; i < sorted.length; i++) {
    const b = sorted[i];
    if (b.maxWeightG < b.minWeightG)
      return `Bracket ${b.minWeightG}–${b.maxWeightG} g ends before it starts`;
    const next = sorted[i + 1];
    if (next && next.minWeightG !== b.maxWeightG + 1) {
      return next.minWeightG <= b.maxWeightG
        ? `Brackets ${b.minWeightG}–${b.maxWeightG} g and ${next.minWeightG}–${next.maxWeightG} g overlap`
        : `Weights ${b.maxWeightG + 1}–${next.minWeightG - 1} g are not covered by any bracket`;
    }
  }
  return null;
}

@Injectable()
export class ShippingRatesAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shipping: ShippingService,
    private readonly audit: AuditService,
  ) {}

  list() {
    return this.prisma.shippingRate.findMany({ orderBy: { minWeightG: 'asc' } });
  }

  async create(dto: CreateShippingRateDto, actor: AuthenticatedUser) {
    this.assertFee(dto.feeLkr);
    const current = await this.list();
    this.assertBrackets([...current, { minWeightG: dto.minWeightG, maxWeightG: dto.maxWeightG }]);
    const created = await this.prisma.shippingRate.create({
      data: {
        minWeightG: dto.minWeightG,
        maxWeightG: dto.maxWeightG,
        feeLkr: new Prisma.Decimal(dto.feeLkr),
        label: dto.label.trim(),
      },
    });
    await this.after(actor, 'shipping-rate.create', created.id, { ...dto });
    return created;
  }

  async update(id: string, dto: UpdateShippingRateDto, actor: AuthenticatedUser) {
    const current = await this.list();
    const existing = current.find((r) => r.id === id);
    if (!existing) throw new NotFoundException(`Shipping rate ${id} not found`);
    if (dto.feeLkr !== undefined) this.assertFee(dto.feeLkr);
    const merged = {
      minWeightG: dto.minWeightG ?? existing.minWeightG,
      maxWeightG: dto.maxWeightG ?? existing.maxWeightG,
    };
    this.assertBrackets(current.map((r) => (r.id === id ? { ...r, ...merged } : r)));
    const updated = await this.prisma.shippingRate.update({
      where: { id },
      data: {
        ...merged,
        feeLkr: dto.feeLkr !== undefined ? new Prisma.Decimal(dto.feeLkr) : undefined,
        label: dto.label?.trim(),
      },
    });
    await this.after(actor, 'shipping-rate.update', id, { ...dto });
    return updated;
  }

  async remove(id: string, actor: AuthenticatedUser) {
    const current = await this.list();
    if (!current.some((r) => r.id === id))
      throw new NotFoundException(`Shipping rate ${id} not found`);
    this.assertBrackets(current.filter((r) => r.id !== id));
    await this.prisma.shippingRate.delete({ where: { id } });
    await this.after(actor, 'shipping-rate.delete', id, {});
    return { id, deleted: true };
  }

  private assertBrackets(brackets: Bracket[]): void {
    const problem = bracketProblem(brackets);
    if (problem) throw new UnprocessableEntityException(problem);
  }

  private assertFee(fee: string): void {
    if (new Prisma.Decimal(fee).lt(0))
      throw new UnprocessableEntityException('feeLkr cannot be negative');
  }

  /** Every change invalidates the Redis bracket cache so checkout sees it at once. */
  private async after(
    actor: AuthenticatedUser,
    action: string,
    targetId: string,
    metadata: Record<string, unknown>,
  ) {
    await this.shipping.invalidateCache();
    await this.audit.record({
      actorType: 'ADMIN',
      actorId: actor.id,
      action,
      targetType: 'ShippingRate',
      targetId,
      metadata,
    });
  }
}
