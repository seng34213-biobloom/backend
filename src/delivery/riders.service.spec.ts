import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import type { AuditService } from '../audit/audit.service';
import type { AuthService } from '../auth/auth.service';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import type { PrismaService } from '../prisma/prisma.service';
import { RidersService } from './riders.service';

const actor = { id: 'admin-1', role: Role.ADMIN } as AuthenticatedUser;
const riderRow = {
  id: 'rider-1',
  email: 'rider@example.com',
  name: 'Rider',
  phone: '0771234567',
  active: true,
  fcmToken: 'token',
  createdAt: new Date(),
  updatedAt: new Date(),
  _count: { assignments: 2 },
};

describe('RidersService', () => {
  let prisma: jest.Mocked<PrismaService>;
  let audit: { record: jest.Mock };
  let service: RidersService;

  beforeEach(() => {
    prisma = {
      deliveryUser: {
        findMany: jest.fn().mockResolvedValue([riderRow]),
        findUnique: jest.fn().mockResolvedValue(riderRow),
        create: jest.fn().mockResolvedValue(riderRow),
        update: jest.fn().mockResolvedValue(riderRow),
      },
    } as unknown as jest.Mocked<PrismaService>;
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new RidersService(
      prisma,
      audit as unknown as AuditService,
      {
        assertEmailFree: jest.fn().mockResolvedValue(undefined),
      } as unknown as AuthService,
    );
  });

  it('reports push status and open work without exposing the device token', async () => {
    const [rider] = await service.list();

    expect(rider).toMatchObject({ pushEnabled: true, openAssignments: 2 });
    expect(rider).not.toHaveProperty('fcmToken');
  });

  it('creates a rider and audits it', async () => {
    await service.create(
      { email: 'Rider@Example.com', password: 'Password123', name: 'Rider', phone: '0771234567' },
      actor,
    );

    expect((prisma.deliveryUser.create as jest.Mock).mock.calls[0][0].data.email).toBe(
      'rider@example.com',
    );
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'rider.create' }));
  });

  it('maps a duplicate email to a conflict', async () => {
    (prisma.deliveryUser.create as jest.Mock).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    await expect(
      service.create(
        { email: 'a@example.com', password: 'Password123', name: 'A', phone: '0771234567' },
        actor,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('answers 404 for an unknown rider', async () => {
    (prisma.deliveryUser.findUnique as jest.Mock).mockResolvedValue(null);
    await expect(service.update('missing', {}, actor)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('clears the push token when a rider is deactivated', async () => {
    await service.update('rider-1', { active: false }, actor);

    expect((prisma.deliveryUser.update as jest.Mock).mock.calls[0][0].data).toEqual({
      active: false,
      fcmToken: null,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'rider.deactivate' }),
    );
  });

  it('updates contact details', async () => {
    await service.update('rider-1', { name: 'New', phone: '0770000000' }, actor);

    expect((prisma.deliveryUser.update as jest.Mock).mock.calls[0][0].data).toEqual({
      name: 'New',
      phone: '0770000000',
    });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'rider.update' }));
  });
});
