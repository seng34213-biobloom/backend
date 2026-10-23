import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AdminRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from './mailer.service';

/**
 * SDS §4.2 NotificationService — async dispatch via EventEmitter2.
 *
 * Feature modules emit domain events and return; the listeners here send the
 * emails. Each handler is `async` and catches its own errors so a recipient
 * lookup or mail failure can never stall or fail the code that emitted it.
 *
 * Current listeners:
 *   OrderConfirmed    → customer (fires from the payment webhook)
 *   BatchExpiringSoon → every active admin (operations alert)
 */

export const DOMAIN_EVENTS = {
  ORDER_CONFIRMED: 'order.confirmed',
  BATCH_EXPIRING_SOON: 'batch.expiringSoon',
  BATCH_EXPIRED: 'batch.expired',
} as const;
export type DomainEvent = (typeof DOMAIN_EVENTS)[keyof typeof DOMAIN_EVENTS];

export interface OrderConfirmedPayload {
  orderId: string;
}

export interface BatchExpiringSoonPayload {
  batchId: string;
  productVariantId: string;
  batchNumber: string;
  expiryDate: Date | string;
  currentQuantity: number;
  daysUntilExpiry: number;
}

@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly emitter: EventEmitter2,
    private readonly mailer: MailerService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.on(DOMAIN_EVENTS.ORDER_CONFIRMED, async (p: OrderConfirmedPayload) => {
      const order = await this.prisma.order.findUnique({
        where: { id: p.orderId },
        select: {
          id: true,
          totalAmount: true,
          currency: true,
          customer: { select: { email: true } },
        },
      });
      if (!order) {
        this.logger.error(`Cannot send confirmation email: order ${p.orderId} not found`);
        return;
      }
      await this.mailer.send({
        to: order.customer.email,
        template: 'ORDER_CONFIRMED',
        data: {
          orderId: order.id,
          totalAmount: order.totalAmount.toFixed(2),
          currency: order.currency,
        },
      });
    });

    this.on(DOMAIN_EVENTS.BATCH_EXPIRING_SOON, async (p: BatchExpiringSoonPayload) => {
      const admins = await this.prisma.adminUser.findMany({
        where: { active: true, role: AdminRole.ADMIN },
        select: { email: true },
      });
      for (const admin of admins) {
        await this.mailer.send({
          to: admin.email,
          template: 'BATCH_EXPIRING_SOON',
          data: {
            batchNumber: p.batchNumber,
            productVariantId: p.productVariantId,
            currentQuantity: p.currentQuantity,
            daysUntilExpiry: p.daysUntilExpiry,
          },
        });
      }
    });
  }

  // ===== helpers ============================================================

  private on<T>(event: string, handler: (payload: T) => Promise<void>): void {
    this.emitter.on(event, async (payload: T) => {
      try {
        await handler(payload);
      } catch (e) {
        this.logger.error(`Listener ${event} failed: ${(e as Error).message}`);
      }
    });
  }
}
