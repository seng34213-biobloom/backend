import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AdminRole, Prisma, Role } from '@prisma/client';
import type { AuditService } from '../audit/audit.service';
import type { AuthService } from '../auth/auth.service';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import type { PrismaService } from '../prisma/prisma.service';
import { StaffService } from './staff.service';

const actor = { id: 'admin-1', role: Role.ADMIN } as AuthenticatedUser;
const uniqueError = new Prisma.PrismaClientKnownRequestError('duplicate', {
  code: 'P2002',
  clientVersion: 'test',
});

describe('StaffService', () => {
  let prisma: jest.Mocked<PrismaService>;
  let auth: { assertEmailFree: jest.Mock };
  let audit: { record: jest.Mock };
  let service: StaffService;

  beforeEach(() => {
    prisma = {
      adminUser: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        create: jest.fn().mockResolvedValue({ id: 'staff-1', role: AdminRole.FULFILMENT_STAFF }),
        update: jest.fn().mockResolvedValue({ id: 'staff-1', role: AdminRole.ADMIN, active: true }),
        count: jest.fn().mockResolvedValue(1),
      },
    } as unknown as jest.Mocked<PrismaService>;
    auth = { assertEmailFree: jest.fn().mockResolvedValue(undefined) };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new StaffService(
      prisma,
      audit as unknown as AuditService,
      auth as unknown as AuthService,
    );
  });

  const dto = {
    email: ' Packer@Example.com ',
    password: 'Password123',
    name: 'Packer',
    role: AdminRole.FULFILMENT_STAFF,
  };

  it('lists accounts without selecting the password hash', async () => {
    await service.list();
    const { select } = (prisma.adminUser.findMany as jest.Mock).mock.calls[0][0];
    expect(select.passwordHash).toBeUndefined();
  });

  it('normalises the email, hashes the password and audits a new account', async () => {
    await service.create(dto, actor);

    const { data } = (prisma.adminUser.create as jest.Mock).mock.calls[0][0];
    expect(auth.assertEmailFree).toHaveBeenCalledWith('packer@example.com');
    expect(data.email).toBe('packer@example.com');
    expect(data.passwordHash).not.toBe(dto.password);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'staff.create', actorId: actor.id }),
    );
  });

  it('maps a duplicate email to a conflict', async () => {
    (prisma.adminUser.create as jest.Mock).mockRejectedValue(uniqueError);
    await expect(service.create(dto, actor)).rejects.toBeInstanceOf(ConflictException);
  });

  it('answers 404 when updating an unknown account', async () => {
    (prisma.adminUser.findUnique as jest.Mock).mockResolvedValue(null);
    await expect(service.update('missing', {}, actor)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('stops admins deactivating or demoting themselves', async () => {
    (prisma.adminUser.findUnique as jest.Mock).mockResolvedValue({
      id: actor.id,
      role: AdminRole.ADMIN,
      active: true,
    });
    await expect(service.update(actor.id, { active: false }, actor)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      service.update(actor.id, { role: AdminRole.FULFILMENT_STAFF }, actor),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('keeps at least one active admin', async () => {
    (prisma.adminUser.findUnique as jest.Mock).mockResolvedValue({
      id: 'admin-2',
      role: AdminRole.ADMIN,
      active: true,
    });
    (prisma.adminUser.count as jest.Mock).mockResolvedValue(0);

    await expect(service.update('admin-2', { active: false }, actor)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('updates another account and audits the change', async () => {
    (prisma.adminUser.findUnique as jest.Mock).mockResolvedValue({
      id: 'staff-1',
      role: AdminRole.FULFILMENT_STAFF,
      active: true,
    });

    await service.update('staff-1', { role: AdminRole.ADMIN }, actor);

    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'staff.update' }));
  });
});
