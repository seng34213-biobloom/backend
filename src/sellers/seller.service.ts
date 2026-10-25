import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { SellerStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService, BCRYPT_COST } from '../auth/auth.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import type { ApplyDto } from './dto/apply.dto';

/**
 * Seller onboarding state machine. Lawful transitions:
 *   (new)    → PENDING        (apply)
 *   PENDING  → APPROVED       (admin approve)
 *   PENDING  → REJECTED       (admin reject)
 *   APPROVED → SUSPENDED      (admin suspend, Phase 7+)
 *   SUSPENDED → APPROVED      (admin reinstate, Phase 7+)
 * Any other transition is a BadRequest.
 */
@Injectable()
export class SellerService {
  private readonly logger = new Logger(SellerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async apply(dto: ApplyDto): Promise<{ id: string; status: SellerStatus; email: string }> {
    const email = dto.email.trim().toLowerCase();
    await this.auth.assertEmailFree(email);
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_COST);
    const seller = await this.prisma.seller.create({
      data: {
        email,
        passwordHash,
        businessName: dto.businessName.trim(),
        contactName: dto.contactName.trim(),
        phone: dto.phone.trim(),
        taxId: dto.taxId?.trim(),
        status: SellerStatus.PENDING,
      },
      select: { id: true, email: true, status: true, businessName: true },
    });
    this.notifications.emitSellerApplied({
      sellerId: seller.id,
      email: seller.email,
      businessName: seller.businessName,
    });
    this.logger.log(`Seller application ${seller.id} (${seller.email}) → PENDING`);
    return { id: seller.id, status: seller.status as SellerStatus, email: seller.email };
  }

  async listPending(): Promise<
    Array<{
      id: string;
      email: string;
      businessName: string;
      contactName: string;
      phone: string;
      taxId: string | null;
      createdAt: Date;
    }>
  > {
    return this.prisma.seller.findMany({
      where: { status: SellerStatus.PENDING },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        email: true,
        businessName: true,
        contactName: true,
        phone: true,
        taxId: true,
        createdAt: true,
      },
    });
  }

  async approve(sellerId: string, adminId: string): Promise<{ id: string; status: SellerStatus }> {
    const seller = await this.requireSeller(sellerId);
    if (seller.status !== SellerStatus.PENDING) {
      throw new BadRequestException(
        `Cannot approve seller in status ${seller.status} (only PENDING is approvable)`,
      );
    }
    const updated = await this.prisma.seller.update({
      where: { id: sellerId },
      data: {
        status: SellerStatus.APPROVED,
        approvedAt: new Date(),
        approvedByAdminId: adminId,
        rejectionReason: null,
      },
      select: { id: true, status: true, email: true, businessName: true },
    });
    await this.audit.record({
      actorType: 'ADMIN',
      actorId: adminId,
      action: 'seller.approve',
      targetType: 'Seller',
      targetId: updated.id,
      metadata: { previousStatus: SellerStatus.PENDING },
    });
    this.notifications.emitSellerApproved({
      sellerId: updated.id,
      email: updated.email,
      businessName: updated.businessName,
      approvedByAdminId: adminId,
    });
    this.logger.log(`Seller ${updated.id} APPROVED by admin ${adminId}`);
    return { id: updated.id, status: updated.status as SellerStatus };
  }

  async reject(
    sellerId: string,
    adminId: string,
    reason: string,
  ): Promise<{ id: string; status: SellerStatus }> {
    const seller = await this.requireSeller(sellerId);
    if (seller.status !== SellerStatus.PENDING) {
      throw new BadRequestException(
        `Cannot reject seller in status ${seller.status} (only PENDING is rejectable)`,
      );
    }
    const updated = await this.prisma.seller.update({
      where: { id: sellerId },
      data: {
        status: SellerStatus.REJECTED,
        rejectionReason: reason.trim(),
      },
      select: { id: true, status: true, email: true, businessName: true },
    });
    await this.audit.record({
      actorType: 'ADMIN',
      actorId: adminId,
      action: 'seller.reject',
      targetType: 'Seller',
      targetId: updated.id,
      metadata: { previousStatus: SellerStatus.PENDING, reason: reason.trim() },
    });
    this.notifications.emitSellerRejected({
      sellerId: updated.id,
      email: updated.email,
      businessName: updated.businessName,
      rejectedByAdminId: adminId,
      reason: reason.trim(),
    });
    this.logger.log(`Seller ${updated.id} REJECTED by admin ${adminId}`);
    return { id: updated.id, status: updated.status as SellerStatus };
  }

  private async requireSeller(sellerId: string) {
    const seller = await this.prisma.seller.findUnique({ where: { id: sellerId } });
    if (!seller) {
      throw new NotFoundException(`Seller ${sellerId} not found`);
    }
    return seller;
  }

  /**
   * Idempotency helper: if the same email re-submits, returning the same
   * 409 (via AuthService.assertEmailFree) is the right behavior. Exposed
   * for documentation; the public API uses ConflictException.
   */
  /* istanbul ignore next */
  /** @internal */
  duplicateEmail(): ConflictException {
    return new ConflictException('Email already registered');
  }
}
