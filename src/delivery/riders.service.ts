import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { DeliveryAssignmentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuthService, BCRYPT_COST } from '../auth/auth.service';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import type { CreateRiderDto, UpdateRiderDto } from './dto/rider.dto';

const OPEN_ASSIGNMENT_STATUSES = [
  DeliveryAssignmentStatus.ASSIGNED,
  DeliveryAssignmentStatus.PICKED_UP,
  DeliveryAssignmentStatus.OUT_FOR_DELIVERY,
];

const RIDER_SELECT = {
  id: true,
  email: true,
  name: true,
  phone: true,
  active: true,
  fcmToken: true,
  createdAt: true,
  updatedAt: true,
  _count: {
    select: { assignments: { where: { status: { in: OPEN_ASSIGNMENT_STATUSES } } } },
  },
} satisfies Prisma.DeliveryUserSelect;

type RiderRow = Prisma.DeliveryUserGetPayload<{ select: typeof RIDER_SELECT }>;

export interface RiderView {
  id: string;
  email: string;
  name: string;
  phone: string;
  active: boolean;
  /** The rider's device has registered for push (the token itself stays server-side). */
  pushEnabled: boolean;
  openAssignments: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Rider accounts (DDP-#28). Created by staff only — never self-registered —
 * with the same bcrypt cost and cross-table email uniqueness as every other
 * actor (SDS §7.2, §7.3). Every change is audited.
 */
@Injectable()
export class RidersService {
  private readonly logger = new Logger(RidersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
  ) {}

  async list(): Promise<RiderView[]> {
    const rows = await this.prisma.deliveryUser.findMany({
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
      select: RIDER_SELECT,
    });
    return rows.map(toView);
  }

  async create(dto: CreateRiderDto, actor: AuthenticatedUser): Promise<RiderView> {
    const email = dto.email.trim().toLowerCase();
    await this.auth.assertEmailFree(email);
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_COST);
    let row: RiderRow;
    try {
      row = await this.prisma.deliveryUser.create({
        data: { email, passwordHash, name: dto.name, phone: dto.phone },
        select: RIDER_SELECT,
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Email already registered');
      }
      throw e;
    }
    await this.audit.record({
      actorType: 'ADMIN',
      actorId: actor.id,
      action: 'rider.create',
      targetType: 'DeliveryUser',
      targetId: row.id,
      metadata: { email },
    });
    this.logger.log(`Rider ${row.id} created by ${actor.id}`);
    return toView(row);
  }

  async update(id: string, dto: UpdateRiderDto, actor: AuthenticatedUser): Promise<RiderView> {
    const existing = await this.prisma.deliveryUser.findUnique({
      where: { id },
      select: { id: true, active: true, name: true, phone: true },
    });
    if (!existing) throw new NotFoundException(`Rider ${id} not found`);

    const data: Prisma.DeliveryUserUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.phone !== undefined) data.phone = dto.phone;
    if (dto.active !== undefined) {
      data.active = dto.active;
      // A deactivated rider's device must stop receiving pushes.
      if (!dto.active) data.fcmToken = null;
    }

    const row = await this.prisma.deliveryUser.update({
      where: { id },
      data,
      select: RIDER_SELECT,
    });
    await this.audit.record({
      actorType: 'ADMIN',
      actorId: actor.id,
      action: dto.active === false && existing.active ? 'rider.deactivate' : 'rider.update',
      targetType: 'DeliveryUser',
      targetId: id,
      metadata: {
        before: { active: existing.active, name: existing.name, phone: existing.phone },
        changes: { ...dto },
      },
    });
    return toView(row);
  }
}

function toView(row: RiderRow): RiderView {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    phone: row.phone,
    active: row.active,
    pushEnabled: Boolean(row.fcmToken),
    openAssignments: row._count.assignments,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
