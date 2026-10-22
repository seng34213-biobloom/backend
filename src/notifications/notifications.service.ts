import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from './mailer.service';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: MailerService,
  ) {}

  @OnEvent('order.confirmed')
  async sendOrderConfirmation(payload: { orderId: string }): Promise<void> {
    try {
      const order = await this.prisma.order.findUnique({
        where: { id: payload.orderId },
        select: {
          id: true,
          totalAmount: true,
          currency: true,
          customer: { select: { email: true } },
        },
      });
      if (!order) {
        this.logger.error(`Cannot send confirmation email: order ${payload.orderId} not found`);
        return;
      }
      await this.mailer.sendOrderConfirmed({
        to: order.customer.email,
        orderId: order.id,
        totalAmount: order.totalAmount.toFixed(2),
        currency: order.currency,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Unknown notification error';
      this.logger.error(`Order confirmation listener failed: ${detail}`);
    }
  }
}
