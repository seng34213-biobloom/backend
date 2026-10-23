import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from './mailer.service';
import { DOMAIN_EVENTS, NotificationsService } from './notifications.service';

describe('NotificationsService', () => {
  let emitter: EventEmitter2;
  let mailer: jest.Mocked<MailerService>;
  let prisma: jest.Mocked<PrismaService>;

  const payload = {
    batchId: 'b-1',
    productVariantId: 'v-1',
    batchNumber: 'B-001',
    expiryDate: '2026-10-26',
    currentQuantity: 12,
    daysUntilExpiry: 5,
  };

  beforeEach(() => {
    emitter = new EventEmitter2();
    mailer = {
      send: jest.fn().mockResolvedValue({ accepted: true, templateId: 'd-batch-expiring-soon' }),
    } as unknown as jest.Mocked<MailerService>;
    prisma = {
      adminUser: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ email: 'ops@biobloom.lk' }, { email: 'owner@biobloom.lk' }]),
      },
    } as unknown as jest.Mocked<PrismaService>;
    new NotificationsService(emitter, mailer, prisma).onModuleInit();
  });

  it('emails every active admin when a batch is expiring soon', async () => {
    await emitter.emitAsync(DOMAIN_EVENTS.BATCH_EXPIRING_SOON, payload);

    expect(prisma.adminUser.findMany).toHaveBeenCalledWith({
      where: { active: true, role: 'ADMIN' },
      select: { email: true },
    });
    expect(mailer.send).toHaveBeenCalledTimes(2);
    expect(mailer.send).toHaveBeenCalledWith({
      to: 'ops@biobloom.lk',
      template: 'BATCH_EXPIRING_SOON',
      data: {
        batchNumber: 'B-001',
        productVariantId: 'v-1',
        currentQuantity: 12,
        daysUntilExpiry: 5,
      },
    });
  });

  it('keeps going when a send is not accepted', async () => {
    mailer.send.mockResolvedValueOnce({ accepted: false, templateId: 'd-batch-expiring-soon' });

    await expect(
      emitter.emitAsync(DOMAIN_EVENTS.BATCH_EXPIRING_SOON, payload),
    ).resolves.toBeDefined();
    expect(mailer.send).toHaveBeenCalledTimes(2);
  });

  it('never lets a listener error escape to the emitter', async () => {
    (prisma.adminUser.findMany as jest.Mock).mockRejectedValueOnce(new Error('database down'));

    await expect(
      emitter.emitAsync(DOMAIN_EVENTS.BATCH_EXPIRING_SOON, payload),
    ).resolves.toBeDefined();
    expect(mailer.send).not.toHaveBeenCalled();
  });
});
