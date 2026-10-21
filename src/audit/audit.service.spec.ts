import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from './audit.service';

describe('AuditService', () => {
  let prisma: jest.Mocked<PrismaService>;
  let audit: AuditService;

  beforeEach(() => {
    prisma = { auditLog: { create: jest.fn() } } as unknown as jest.Mocked<PrismaService>;
    audit = new AuditService(prisma);
  });

  it('writes an audit row', async () => {
    await audit.record({
      actorType: 'ADMIN',
      actorId: 'admin-1',
      action: 'batch.create',
      targetType: 'ProductBatch',
      targetId: 'b-1',
      metadata: { productId: 'p-1' },
    });

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        actorType: 'ADMIN',
        actorId: 'admin-1',
        action: 'batch.create',
        targetType: 'ProductBatch',
        targetId: 'b-1',
        metadata: { productId: 'p-1' },
        ipAddress: null,
        userAgent: null,
      },
    });
  });

  it('never fails the request when the write fails', async () => {
    (prisma.auditLog.create as jest.Mock).mockRejectedValue(new Error('database unavailable'));

    await expect(
      audit.record({
        actorType: 'SYSTEM',
        actorId: null,
        action: 'batch.create',
        targetType: 'ProductBatch',
        targetId: null,
      }),
    ).resolves.toBeUndefined();
  });
});
