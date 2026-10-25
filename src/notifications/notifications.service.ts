import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AdminRole, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from './mailer.service';
import type { TemplateKey } from './templates.config';

/**
 * SDS §4.2 NotificationService — async dispatch via EventEmitter2.
 *
 * Feature modules call the typed `emit…` helpers and return; the listeners
 * registered in `onModuleInit` look up recipients and send the email. Each
 * handler catches its own errors and MailerService never throws, so a mail
 * failure can never block or fail the request that raised the event.
 *
 * Who gets what:
 *   customer — order.confirmed/shipped/delivered, subscription.renewed/cancelled/
 *              stockDelayed/chargeFailed, refund.approved
 *   seller   — seller.approved
 *   admins   — batch.expiringSoon
 *   log only — seller.applied, seller.rejected, refund.rejected
 *
 * Pitfall: EventEmitter2 is in-process with no retry, so a crash between the
 * database commit and the send loses that email.
 */

export const DOMAIN_EVENTS = {
  SELLER_APPLIED: 'seller.applied',
  SELLER_APPROVED: 'seller.approved',
  SELLER_REJECTED: 'seller.rejected',
  SUBSCRIPTION_RENEWED: 'subscription.renewed',
  SUBSCRIPTION_CANCELLED: 'subscription.cancelled',
  SUBSCRIPTION_STOCK_DELAYED: 'subscription.stockDelayed',
  SUBSCRIPTION_CHARGE_FAILED: 'subscription.chargeFailed',
  ORDER_CONFIRMED: 'order.confirmed',
  ORDER_SHIPPED: 'order.shipped',
  ORDER_DELIVERED: 'order.delivered',
  REFUND_APPROVED: 'refund.approved',
  REFUND_REJECTED: 'refund.rejected',
  /** Raised by the daily expiry sweep (batches/expiry-cron.service.ts). */
  BATCH_EXPIRING_SOON: 'batch.expiringSoon',
  BATCH_EXPIRED: 'batch.expired',
  DELIVERY_ASSIGNED: 'delivery.assigned',
} as const;
export type DomainEvent = (typeof DOMAIN_EVENTS)[keyof typeof DOMAIN_EVENTS];

export interface SellerAppliedPayload {
  sellerId: string;
  email: string;
  businessName: string;
}
export interface SellerApprovedPayload {
  sellerId: string;
  email: string;
  businessName: string;
  approvedByAdminId: string;
}
export interface SellerRejectedPayload {
  sellerId: string;
  email: string;
  businessName: string;
  rejectedByAdminId: string;
  reason: string;
}
export interface SubscriptionRenewedPayload {
  subscriptionId: string;
  customerId: string;
  orderId: string;
  amount: string;
  currency: string;
}
export interface SubscriptionCancelledPayload {
  subscriptionId: string;
  customerId: string;
}
export interface SubscriptionStockDelayedPayload {
  subscriptionId: string;
  customerId: string;
  productVariantId: string;
  requested: number;
  available: number;
}
export interface SubscriptionChargeFailedPayload {
  subscriptionId: string;
  customerId: string;
  reason: string;
}
export interface OrderConfirmedPayload {
  orderId: string;
}
export interface OrderShippedPayload {
  orderId: string;
  actorId: string;
}
export interface OrderDeliveredPayload {
  orderId: string;
  actorId: string;
}
export interface RefundApprovedPayload {
  refundRequestId: string;
  customerId: string;
  orderId: string;
  amount: string;
}
export interface RefundRejectedPayload {
  refundRequestId: string;
  customerId: string;
  orderId: string;
  reason: string;
}
export interface BatchExpiringSoonPayload {
  batchId: string;
  productVariantId: string;
  batchNumber: string;
  expiryDate: Date | string;
  currentQuantity: number;
  daysUntilExpiry: number;
}
export interface BatchExpiredPayload {
  batchId: string;
  productVariantId: string;
  batchNumber: string;
  expiryDate: Date | string;
  currentQuantity: number;
}
export interface DeliveryAssignedPayload {
  assignmentId: string;
  orderId: string;
  deliveryUserId: string;
}

interface OrderContext {
  orderId: string;
  email: string;
  totalAmount: string;
  currency: string;
}

interface SubscriptionContext {
  productName: string | null;
  nextBillingDate: string | null;
}

@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly storefrontUrl: string;
  private readonly sellerUrl: string;

  constructor(
    private readonly emitter: EventEmitter2,
    private readonly mailer: MailerService,
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.storefrontUrl = trimSlash(config.get<string>('STOREFRONT_URL') ?? 'http://localhost:3000');
    this.sellerUrl = trimSlash(config.get<string>('SELLER_PORTAL_URL') ?? 'http://localhost:3002');
  }

  onModuleInit(): void {
    // ----- sellers -----------------------------------------------------------
    this.on(DOMAIN_EVENTS.SELLER_APPLIED, async (p: SellerAppliedPayload) => {
      this.logger.log(`seller.applied ${p.sellerId} (${p.businessName})`);
    });
    this.on(DOMAIN_EVENTS.SELLER_APPROVED, async (p: SellerApprovedPayload) => {
      await this.mailer.send({
        to: p.email,
        template: 'SELLER_APPROVED',
        data: { businessName: p.businessName, portalUrl: this.sellerUrl },
      });
    });
    this.on(DOMAIN_EVENTS.SELLER_REJECTED, async (p: SellerRejectedPayload) => {
      this.logger.log(`seller.rejected ${p.sellerId} (${p.businessName}): ${p.reason}`);
    });

    // ----- orders ------------------------------------------------------------
    this.on(DOMAIN_EVENTS.ORDER_CONFIRMED, async (p: OrderConfirmedPayload) => {
      const ctx = await this.orderContext(p.orderId);
      if (!ctx) return;
      await this.mailer.send({
        to: ctx.email,
        template: 'ORDER_CONFIRMED',
        data: {
          orderId: ctx.orderId,
          totalAmount: ctx.totalAmount,
          currency: ctx.currency,
          orderUrl: this.orderUrl(ctx.orderId),
        },
      });
    });
    this.on(DOMAIN_EVENTS.ORDER_SHIPPED, async (p: OrderShippedPayload) => {
      await this.sendOrderMail(p.orderId, 'ORDER_SHIPPED');
    });
    this.on(DOMAIN_EVENTS.ORDER_DELIVERED, async (p: OrderDeliveredPayload) => {
      await this.sendOrderMail(p.orderId, 'ORDER_DELIVERED');
    });

    // ----- subscriptions (SDS §5.4, §5.5, §7.5) -------------------------------
    this.on(DOMAIN_EVENTS.SUBSCRIPTION_RENEWED, async (p: SubscriptionRenewedPayload) => {
      const email = await this.customerEmail(p.customerId);
      if (!email) return;
      await this.mailer.send({
        to: email,
        template: 'SUBSCRIPTION_RENEWED',
        data: {
          subscriptionId: p.subscriptionId,
          orderId: p.orderId,
          amount: p.amount,
          currency: p.currency,
          manageUrl: this.subscriptionsUrl(),
        },
      });
    });
    this.on(DOMAIN_EVENTS.SUBSCRIPTION_CANCELLED, async (p: SubscriptionCancelledPayload) => {
      const email = await this.customerEmail(p.customerId);
      if (!email) return;
      const sub = await this.subscriptionContext(p.subscriptionId);
      await this.mailer.send({
        to: email,
        template: 'SUBSCRIPTION_CANCELLED',
        data: { subscriptionId: p.subscriptionId, productName: sub.productName },
      });
    });

    this.on(
      DOMAIN_EVENTS.SUBSCRIPTION_STOCK_DELAYED,
      async (p: SubscriptionStockDelayedPayload) => {
        const email = await this.customerEmail(p.customerId);
        if (!email) return;
        const sub = await this.subscriptionContext(p.subscriptionId);
        await this.mailer.send({
          to: email,
          template: 'SUBSCRIPTION_STOCK_DELAYED',
          data: {
            subscriptionId: p.subscriptionId,
            productName: sub.productName,
            nextBillingDate: sub.nextBillingDate,
            requested: p.requested,
            available: p.available,
            manageUrl: this.subscriptionsUrl(),
          },
        });
      },
    );
    this.on(
      DOMAIN_EVENTS.SUBSCRIPTION_CHARGE_FAILED,
      async (p: SubscriptionChargeFailedPayload) => {
        const email = await this.customerEmail(p.customerId);
        if (!email) return;
        const sub = await this.subscriptionContext(p.subscriptionId);
        await this.mailer.send({
          to: email,
          template: 'SUBSCRIPTION_CHARGE_FAILED',
          data: {
            subscriptionId: p.subscriptionId,
            productName: sub.productName,
            nextBillingDate: sub.nextBillingDate,
            reason: p.reason,
            manageUrl: this.subscriptionsUrl(),
          },
        });
      },
    );

    // ----- refunds -----------------------------------------------------------
    this.on(DOMAIN_EVENTS.REFUND_APPROVED, async (p: RefundApprovedPayload) => {
      const email = await this.customerEmail(p.customerId);
      if (!email) return;
      const order = await this.prisma.order.findUnique({
        where: { id: p.orderId },
        select: { currency: true },
      });
      await this.mailer.send({
        to: email,
        template: 'REFUND_ISSUED',
        data: { orderId: p.orderId, amount: p.amount, currency: order?.currency ?? 'LKR' },
      });
    });
    this.on(DOMAIN_EVENTS.REFUND_REJECTED, async (p: RefundRejectedPayload) => {
      this.logger.log(`refund.rejected ${p.refundRequestId} order=${p.orderId}: ${p.reason}`);
    });

    // ----- batches (SDS §5.6) --------------------------------------------------
    this.on(DOMAIN_EVENTS.BATCH_EXPIRING_SOON, async (p: BatchExpiringSoonPayload) => {
      await this.sendToMany(await this.adminEmails(), 'BATCH_EXPIRING_SOON', {
        batchNumber: p.batchNumber,
        productVariantId: p.productVariantId,
        currentQuantity: p.currentQuantity,
        daysUntilExpiry: p.daysUntilExpiry,
      });
    });
    this.on(DOMAIN_EVENTS.DELIVERY_ASSIGNED, async (p: DeliveryAssignedPayload) => {
      this.logger.log(
        `delivery.assigned assignment=${p.assignmentId} order=${p.orderId} rider=${p.deliveryUserId}`,
      );
    });
  }

  // ===== emit helpers =======================================================

  emitSellerApplied(p: SellerAppliedPayload): void {
    this.emitter.emit(DOMAIN_EVENTS.SELLER_APPLIED, p);
  }
  emitSellerApproved(p: SellerApprovedPayload): void {
    this.emitter.emit(DOMAIN_EVENTS.SELLER_APPROVED, p);
  }
  emitSellerRejected(p: SellerRejectedPayload): void {
    this.emitter.emit(DOMAIN_EVENTS.SELLER_REJECTED, p);
  }
  emitOrderConfirmed(p: OrderConfirmedPayload): void {
    this.emitter.emit(DOMAIN_EVENTS.ORDER_CONFIRMED, p);
  }
  emitOrderShipped(p: OrderShippedPayload): void {
    this.emitter.emit(DOMAIN_EVENTS.ORDER_SHIPPED, p);
  }
  emitOrderDelivered(p: OrderDeliveredPayload): void {
    this.emitter.emit(DOMAIN_EVENTS.ORDER_DELIVERED, p);
  }
  emitSubscriptionRenewed(p: SubscriptionRenewedPayload): void {
    this.emitter.emit(DOMAIN_EVENTS.SUBSCRIPTION_RENEWED, p);
  }
  emitSubscriptionCancelled(p: SubscriptionCancelledPayload): void {
    this.emitter.emit(DOMAIN_EVENTS.SUBSCRIPTION_CANCELLED, p);
  }
  emitSubscriptionStockDelayed(p: SubscriptionStockDelayedPayload): void {
    this.emitter.emit(DOMAIN_EVENTS.SUBSCRIPTION_STOCK_DELAYED, p);
  }
  emitSubscriptionChargeFailed(p: SubscriptionChargeFailedPayload): void {
    this.emitter.emit(DOMAIN_EVENTS.SUBSCRIPTION_CHARGE_FAILED, p);
  }
  emitRefundApproved(p: RefundApprovedPayload): void {
    this.emitter.emit(DOMAIN_EVENTS.REFUND_APPROVED, p);
  }
  emitRefundRejected(p: RefundRejectedPayload): void {
    this.emitter.emit(DOMAIN_EVENTS.REFUND_REJECTED, p);
  }
  emitBatchExpiringSoon(p: BatchExpiringSoonPayload): void {
    this.emitter.emit(DOMAIN_EVENTS.BATCH_EXPIRING_SOON, p);
  }
  emitBatchExpired(p: BatchExpiredPayload): void {
    this.emitter.emit(DOMAIN_EVENTS.BATCH_EXPIRED, p);
  }
  emitDeliveryAssigned(p: DeliveryAssignedPayload): void {
    this.emitter.emit(DOMAIN_EVENTS.DELIVERY_ASSIGNED, p);
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

  private async sendToMany(
    recipients: string[],
    template: TemplateKey,
    data: Record<string, unknown>,
  ): Promise<void> {
    const unique = [...new Set(recipients.map((r) => r.toLowerCase()))];
    if (unique.length === 0) {
      this.logger.warn(`${template}: no recipients`);
      return;
    }
    for (const to of unique) {
      await this.mailer.send({ to, template, data });
    }
  }

  private async sendOrderMail(orderId: string, template: TemplateKey): Promise<void> {
    const ctx = await this.orderContext(orderId);
    if (!ctx) return;
    await this.mailer.send({
      to: ctx.email,
      template,
      data: { orderId: ctx.orderId, orderUrl: this.orderUrl(ctx.orderId) },
    });
  }

  private orderUrl(orderId: string): string {
    return `${this.storefrontUrl}/account/orders/${orderId}`;
  }

  private subscriptionsUrl(): string {
    return `${this.storefrontUrl}/account/subscriptions`;
  }

  /** Active accounts with role ADMIN (operations alerts). */
  private async adminEmails(): Promise<string[]> {
    const admins = await this.prisma.adminUser.findMany({
      where: { active: true, role: AdminRole.ADMIN },
      select: { email: true },
    });
    return admins.map((a) => a.email);
  }

  private async orderContext(orderId: string): Promise<OrderContext | null> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        totalAmount: true,
        currency: true,
        customer: { select: { email: true } },
      },
    });
    if (!order) {
      this.logger.error(`Cannot send order email: order ${orderId} not found`);
      return null;
    }
    return {
      orderId: order.id,
      email: order.customer.email,
      totalAmount: new Prisma.Decimal(order.totalAmount).toFixed(2),
      currency: order.currency,
    };
  }

  private async subscriptionContext(subscriptionId: string): Promise<SubscriptionContext> {
    const sub = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
      select: {
        nextBillingDate: true,
        variant: { select: { name: true, product: { select: { name: true } } } },
      },
    });
    if (!sub) return { productName: null, nextBillingDate: null };
    return {
      productName: `${sub.variant.product.name} (${sub.variant.name})`,
      nextBillingDate: isoDate(sub.nextBillingDate),
    };
  }

  private async customerEmail(customerId: string): Promise<string | null> {
    const c = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { email: true },
    });
    return c?.email ?? null;
  }
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function isoDate(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString().slice(0, 10);
}
