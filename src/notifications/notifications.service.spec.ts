import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from './mailer.service';
import { NotificationsService } from './notifications.service';

describe('NotificationsService', () => {
  it('sends an order confirmation email to the customer after payment succeeds', async () => {
    const prisma = {
      order: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'order-1',
          totalAmount: { toFixed: () => '1500.00' },
          currency: 'LKR',
          customer: { email: 'customer@example.com' },
        }),
      },
    } as unknown as PrismaService;
    const mailer = { sendOrderConfirmed: jest.fn().mockResolvedValue(undefined) };
    const service = new NotificationsService(prisma, mailer as unknown as MailerService);

    await service.sendOrderConfirmation({ orderId: 'order-1' });

    expect(prisma.order.findUnique).toHaveBeenCalledWith({
      where: { id: 'order-1' },
      select: {
        id: true,
        totalAmount: true,
        currency: true,
        customer: { select: { email: true } },
      },
    });
    expect(mailer.sendOrderConfirmed).toHaveBeenCalledWith({
      to: 'customer@example.com',
      orderId: 'order-1',
      totalAmount: '1500.00',
      currency: 'LKR',
    });
  });
});
