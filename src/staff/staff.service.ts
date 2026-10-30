import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { AdminRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuthService, BCRYPT_COST } from '../auth/auth.service';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import type { CreateStaffDto, UpdateStaffDto } from './dto/staff.dto';

const STAFF_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  active: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.AdminUserSelect;

/**
 * Admin console accounts (SDS §7.2 — AdminUser is its own table, separate
 * from customers). ADMIN only. Every change is audited; an admin cannot
 * deactivate or demote themselves, and the last active ADMIN cannot be
 * removed, so the console can never lock itself out.
 */
@Injectable()
export class StaffService {
  private readonly logger = new Logger(StaffService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
  ) {}

  list() {
    return this.prisma.adminUser.findMany({
      orderBy: [{ active: 'desc' }, { role: 'asc' }, { name: 'asc' }],
      select: STAFF_SELECT,
    });
  }

  async create(dto: CreateStaffDto, actor: AuthenticatedUser) {
    const email = dto.email.trim().toLowerCase();
    await this.auth.assertEmailFree(email);
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_COST);
    try {
      const row = await this.prisma.adminUser.create({
        data: { email, passwordHash, name: dto.name, role: dto.role },
        select: STAFF_SELECT,
      });
      await this.audit.record({
        actorType: 'ADMIN',
        actorId: actor.id,
        action: 'staff.create',
        targetType: 'AdminUser',
        targetId: row.id,
        metadata: { email, role: row.role },
      });
      this.logger.log(`Staff account ${row.id} (${row.role}) created by ${actor.id}`);
      return row;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Email already registered');
      }
      throw e;
    }
  }

  async update(id: string, dto: UpdateStaffDto, actor: AuthenticatedUser) {
    const existing = await this.prisma.adminUser.findUnique({
      where: { id },
      select: { id: true, role: true, active: true },
    });
    if (!existing) throw new NotFoundException(`Staff account ${id} not found`);

    if (id === actor.id) {
      if (dto.active === false) {
        throw new BadRequestException('You cannot deactivate your own account');
      }
      if (dto.role !== undefined && dto.role !== existing.role) {
        throw new BadRequestException('You cannot change your own role');
      }
    }

    const nextRole = dto.role ?? existing.role;
    const nextActive = dto.active ?? existing.active;
    const losesAdmin =
      existing.role === AdminRole.ADMIN &&
      existing.active &&
      (nextRole !== AdminRole.ADMIN || !nextActive);
    if (losesAdmin) {
      const otherAdmins = await this.prisma.adminUser.count({
        where: { role: AdminRole.ADMIN, active: true, NOT: { id } },
      });
      if (otherAdmins === 0) {
        throw new ConflictException('At least one active ADMIN account must remain');
      }
    }

    const row = await this.prisma.adminUser.update({
      where: { id },
      data: {
        ...(dto.active !== undefined ? { active: dto.active } : {}),
        ...(dto.role !== undefined ? { role: dto.role } : {}),
      },
      select: STAFF_SELECT,
    });
    await this.audit.record({
      actorType: 'ADMIN',
      actorId: actor.id,
      action: 'staff.update',
      targetType: 'AdminUser',
      targetId: id,
      metadata: {
        before: { role: existing.role, active: existing.active },
        after: { role: row.role, active: row.active },
      },
    });
    return row;
  }
}
