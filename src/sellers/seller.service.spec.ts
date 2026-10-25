import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { SellerStatus } from '@prisma/client';
import { SellerService } from './seller.service';
import { AuthService } from '../auth/auth.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';

function makePrismaMock() {
  return {
    seller: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn(),
    },
    auditLog: { create: jest.fn().mockResolvedValue({ id: 'al1' }) },
  } as unknown as jest.Mocked<PrismaService>;
}

function makeAuthMock(): jest.Mocked<Pick<AuthService, 'assertEmailFree'>> {
  return { assertEmailFree: jest.fn().mockResolvedValue(undefined) };
}

function makeNotificationsMock(): jest.Mocked<
  Pick<NotificationsService, 'emitSellerApplied' | 'emitSellerApproved' | 'emitSellerRejected'>
> {
  return {
    emitSellerApplied: jest.fn(),
    emitSellerApproved: jest.fn(),
    emitSellerRejected: jest.fn(),
  };
}

describe('SellerService', () => {
  let svc: SellerService;
  let prisma: jest.Mocked<PrismaService>;
  let auth: jest.Mocked<Pick<AuthService, 'assertEmailFree'>>;
  let audit: jest.Mocked<Pick<AuditService, 'record'>>;
  let notifications: jest.Mocked<
    Pick<NotificationsService, 'emitSellerApplied' | 'emitSellerApproved' | 'emitSellerRejected'>
  >;

  beforeEach(() => {
    prisma = makePrismaMock();
    auth = makeAuthMock();
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    notifications = makeNotificationsMock();
    svc = new SellerService(
      prisma,
      auth as unknown as AuthService,
      audit as unknown as AuditService,
      notifications as unknown as NotificationsService,
    );
  });

  describe('apply', () => {
    it('creates a PENDING seller, hashes the password at cost 12, and emits applied', async () => {
      (prisma.seller.create as jest.Mock).mockResolvedValue({
        id: 's1',
        email: 'seller@bb.lk',
        status: SellerStatus.PENDING,
        businessName: "Amma's Kitchen",
      });
      const out = await svc.apply({
        email: 'Seller@BB.lk',
        password: 'Password123!',
        businessName: " Amma's Kitchen ",
        contactName: ' Nirmala ',
        phone: '+94770000000',
      });
      expect(out).toEqual({ id: 's1', email: 'seller@bb.lk', status: SellerStatus.PENDING });
      expect(auth.assertEmailFree).toHaveBeenCalledWith('seller@bb.lk');
      const args = (prisma.seller.create as jest.Mock).mock.calls[0][0];
      expect(args.data.email).toBe('seller@bb.lk');
      expect(args.data.businessName).toBe("Amma's Kitchen");
      expect(args.data.contactName).toBe('Nirmala');
      expect(args.data.status).toBe(SellerStatus.PENDING);
      expect(args.data.passwordHash).toMatch(/^\$2[aby]\$12\$/);
      const matches = await bcrypt.compare('Password123!', args.data.passwordHash);
      expect(matches).toBe(true);
      expect(notifications.emitSellerApplied).toHaveBeenCalledWith({
        sellerId: 's1',
        email: 'seller@bb.lk',
        businessName: "Amma's Kitchen",
      });
    });

    it('throws Conflict when AuthService finds a duplicate email', async () => {
      auth.assertEmailFree.mockRejectedValue(new ConflictException('Email already registered'));
      await expect(
        svc.apply({
          email: 'seller@bb.lk',
          password: 'Password123!',
          businessName: 'X',
          contactName: 'Y',
          phone: '+94770000000',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.seller.create).not.toHaveBeenCalled();
    });
  });

  describe('listPending', () => {
    it('queries only PENDING sellers ordered by createdAt asc', async () => {
      (prisma.seller.findMany as jest.Mock).mockResolvedValue([]);
      await svc.listPending();
      expect(prisma.seller.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: SellerStatus.PENDING },
          orderBy: { createdAt: 'asc' },
        }),
      );
    });
  });

  describe('approve', () => {
    it('flips PENDING → APPROVED, writes audit, emits notification', async () => {
      (prisma.seller.findUnique as jest.Mock).mockResolvedValue({
        id: 's1',
        email: 'seller@bb.lk',
        status: SellerStatus.PENDING,
      });
      (prisma.seller.update as jest.Mock).mockResolvedValue({
        id: 's1',
        status: SellerStatus.APPROVED,
        email: 'seller@bb.lk',
        businessName: 'BizCo',
      });
      const out = await svc.approve('s1', 'admin-uuid');
      expect(out).toEqual({ id: 's1', status: SellerStatus.APPROVED });
      const updateArgs = (prisma.seller.update as jest.Mock).mock.calls[0][0];
      expect(updateArgs.where).toEqual({ id: 's1' });
      expect(updateArgs.data.status).toBe(SellerStatus.APPROVED);
      expect(updateArgs.data.approvedByAdminId).toBe('admin-uuid');
      expect(updateArgs.data.rejectionReason).toBeNull();
      expect(updateArgs.data.approvedAt).toBeInstanceOf(Date);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorType: 'ADMIN',
          actorId: 'admin-uuid',
          action: 'seller.approve',
          targetType: 'Seller',
          targetId: 's1',
        }),
      );
      expect(notifications.emitSellerApproved).toHaveBeenCalledWith(
        expect.objectContaining({ sellerId: 's1', approvedByAdminId: 'admin-uuid' }),
      );
    });

    it('refuses to approve a non-PENDING seller', async () => {
      (prisma.seller.findUnique as jest.Mock).mockResolvedValue({
        id: 's1',
        status: SellerStatus.APPROVED,
      });
      await expect(svc.approve('s1', 'admin-1')).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.seller.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('404s an unknown seller', async () => {
      (prisma.seller.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(svc.approve('missing', 'admin-1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('reject', () => {
    it('flips PENDING → REJECTED, persists reason, writes audit, emits notification', async () => {
      (prisma.seller.findUnique as jest.Mock).mockResolvedValue({
        id: 's1',
        email: 'seller@bb.lk',
        status: SellerStatus.PENDING,
      });
      (prisma.seller.update as jest.Mock).mockResolvedValue({
        id: 's1',
        status: SellerStatus.REJECTED,
        email: 'seller@bb.lk',
        businessName: 'BizCo',
      });
      const out = await svc.reject('s1', 'admin-uuid', '  missing tax ID  ');
      expect(out).toEqual({ id: 's1', status: SellerStatus.REJECTED });
      const updateArgs = (prisma.seller.update as jest.Mock).mock.calls[0][0];
      expect(updateArgs.data.status).toBe(SellerStatus.REJECTED);
      expect(updateArgs.data.rejectionReason).toBe('missing tax ID');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'seller.reject',
          targetId: 's1',
          metadata: expect.objectContaining({ reason: 'missing tax ID' }),
        }),
      );
      expect(notifications.emitSellerRejected).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'missing tax ID', rejectedByAdminId: 'admin-uuid' }),
      );
    });

    it('refuses to reject an APPROVED seller', async () => {
      (prisma.seller.findUnique as jest.Mock).mockResolvedValue({
        id: 's1',
        status: SellerStatus.APPROVED,
      });
      await expect(svc.reject('s1', 'admin-1', 'nope')).rejects.toBeInstanceOf(BadRequestException);
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('refuses to reject an already-REJECTED seller (idempotency)', async () => {
      (prisma.seller.findUnique as jest.Mock).mockResolvedValue({
        id: 's1',
        status: SellerStatus.REJECTED,
      });
      await expect(svc.reject('s1', 'admin-1', 'nope')).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
