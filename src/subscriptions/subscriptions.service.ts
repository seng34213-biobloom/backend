import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, SubscriptionStatus } from '@prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { TokenCipherService } from './token-cipher.service';
import type { CreateSubscriptionDto } from './dto/create-subscription.dto';

/** SDS §6.4 — fixed 10% discount applied at sign-up for the lifetime of
 *  the subscription. The plan locked this rate in `Subscription.discountRate`
 *  so future global price changes don't silently mutate it.
 */
const DEFAULT_DISCOUNT_RATE = '0.1000';

export function startOfTodayUtc(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export function addDaysUtc(base: Date, days: number): Date {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/**
 * Subscribe & Save state machine (SDS §5.5).
 *   (new)      → ACTIVE
 *   ACTIVE     → PAUSED  (customer)
 *   PAUSED     → ACTIVE  (customer)
 *   ACTIVE     → CANCELLED (customer; terminal)
 *   PAUSED     → CANCELLED (customer; terminal)
 *   skipNext: ACTIVE only, advances nextBillingDate by frequencyDays without
 *             billing.
 */
@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: TokenCipherService,
    private readonly notifications: NotificationsService,
  ) {}

  async create(customerId: string, dto: CreateSubscriptionDto) {
    // Address ownership check — the address must belong to the signed-in customer.
    const address = await this.prisma.address.findUnique({
      where: { id: dto.shippingAddressId },
      select: { id: true, customerId: true },
    });
    if (!address) throw new NotFoundException(`Address ${dto.shippingAddressId} not found`);
    if (address.customerId !== customerId) {
      throw new ForbiddenException('Address does not belong to customer');
    }

    const variant = await this.prisma.productVariant.findUnique({
      where: { id: dto.productVariantId },
      select: { id: true, active: true },
    });
    if (!variant || !variant.active) {
      throw new NotFoundException(`Variant ${dto.productVariantId} is not available`);
    }

    // Encrypt the gateway token before it leaves the request thread.
    // Prisma's `Bytes` column type is typed as Uint8Array<ArrayBuffer> in
    // recent type defs; Node's Buffer needs an explicit Uint8Array view.
    const encryptedToken = new Uint8Array(await this.cipher.encrypt(dto.paymentToken));

    // SDS §5.5 — first billing date = TODAY + frequencyDays.
    const nextBillingDate = addDaysUtc(startOfTodayUtc(), dto.frequencyDays);

    const sub = await this.prisma.subscription.create({
      data: {
        customerId,
        productVariantId: dto.productVariantId,
        shippingAddressId: dto.shippingAddressId,
        frequencyDays: dto.frequencyDays,
        quantity: dto.quantity,
        discountRate: DEFAULT_DISCOUNT_RATE,
        status: SubscriptionStatus.ACTIVE,
        nextBillingDate,
        paymentTokenEncrypted: encryptedToken,
        paymentGateway: dto.paymentGateway,
      },
      select: this.publicSelect(),
    });
    this.logger.log(
      `Subscription ${sub.id} created customer=${customerId} variant=${dto.productVariantId} next=${nextBillingDate.toISOString()}`,
    );
    return this.toPublic(sub);
  }

  async list(customerId: string) {
    const subs = await this.prisma.subscription.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
      select: this.publicSelect(),
    });
    return subs.map((sub) => this.toPublic(sub));
  }

  async pause(customerId: string, subscriptionId: string) {
    const sub = await this.requireOwned(customerId, subscriptionId);
    if (sub.status === SubscriptionStatus.CANCELLED) {
      throw new BadRequestException('Cannot pause a cancelled subscription');
    }
    if (sub.status === SubscriptionStatus.PAUSED) return this.toPublic(sub);
    const updated = await this.prisma.subscription.update({
      where: { id: sub.id },
      data: { status: SubscriptionStatus.PAUSED },
      select: this.publicSelect(),
    });
    return this.toPublic(updated);
  }

  async resume(customerId: string, subscriptionId: string) {
    const sub = await this.requireOwned(customerId, subscriptionId);
    if (sub.status === SubscriptionStatus.CANCELLED) {
      throw new BadRequestException('Cannot resume a cancelled subscription');
    }
    if (sub.status === SubscriptionStatus.ACTIVE) return this.toPublic(sub);

    // If nextBillingDate passed while paused, push to tomorrow at minimum so
    // the next 06:00 cron run doesn't double-bill the customer instantly.
    const today = startOfTodayUtc();
    const nextBillingDate =
      sub.nextBillingDate < today ? addDaysUtc(today, 1) : sub.nextBillingDate;

    const updated = await this.prisma.subscription.update({
      where: { id: sub.id },
      data: { status: SubscriptionStatus.ACTIVE, nextBillingDate },
      select: this.publicSelect(),
    });
    return this.toPublic(updated);
  }

  async cancel(customerId: string, subscriptionId: string) {
    const sub = await this.requireOwned(customerId, subscriptionId);
    if (sub.status === SubscriptionStatus.CANCELLED) return this.toPublic(sub);
    const updated = await this.prisma.subscription.update({
      where: { id: sub.id },
      data: {
        status: SubscriptionStatus.CANCELLED,
        cancelledAt: new Date(),
      },
      select: this.publicSelect(),
    });
    // SDS §7.5 — confirm the cancellation by email.
    this.notifications.emitSubscriptionCancelled({ subscriptionId: sub.id, customerId });
    return this.toPublic(updated);
  }

  async skipNext(customerId: string, subscriptionId: string) {
    const sub = await this.requireOwned(customerId, subscriptionId);
    if (sub.status !== SubscriptionStatus.ACTIVE) {
      throw new BadRequestException('Only ACTIVE subscriptions can skip the next billing');
    }
    const next = addDaysUtc(sub.nextBillingDate, sub.frequencyDays);
    const updated = await this.prisma.subscription.update({
      where: { id: sub.id },
      data: { nextBillingDate: next },
      select: this.publicSelect(),
    });
    return this.toPublic(updated);
  }

  private async requireOwned(customerId: string, subscriptionId: string) {
    const sub = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
      select: this.publicSelect(),
    });
    if (!sub) throw new NotFoundException(`Subscription ${subscriptionId} not found`);
    if (sub.customerId !== customerId) {
      throw new ForbiddenException('Not your subscription');
    }
    return sub;
  }

  /**
   * Strip the encrypted token bytes from public reads — even the owner
   * customer never sees their stored token over the API.
   */
  private publicSelect() {
    return {
      id: true,
      customerId: true,
      productVariantId: true,
      shippingAddressId: true,
      frequencyDays: true,
      discountRate: true,
      quantity: true,
      status: true,
      nextBillingDate: true,
      paymentGateway: true,
      cancelledAt: true,
      createdAt: true,
      updatedAt: true,
      // Product and variant names for the My Subscriptions dashboard cards
      variant: {
        select: {
          id: true,
          name: true,
          size: true,
          product: { select: { id: true, name: true, slug: true } },
        },
      },
    } as const;
  }

  /**
   * Shapes a subscription for the API: the locked discount rate with four
   * decimals (e.g. "0.1000"), and the product and variant as separate objects.
   */
  private toPublic<
    T extends {
      discountRate: Prisma.Decimal | string;
      variant: {
        id: string;
        name: string;
        size: string;
        product: { id: string; name: string; slug: string };
      };
    },
  >(sub: T) {
    const { variant, ...rest } = sub;
    return {
      ...rest,
      discountRate: new Prisma.Decimal(sub.discountRate).toFixed(4),
      product: variant.product,
      variant: { id: variant.id, name: variant.name, size: variant.size },
    };
  }
}
