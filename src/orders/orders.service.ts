import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OrderStatus, PaymentGateway, PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { ShippingItemWeight, ShippingService } from '../shipping/shipping.service';
import { PaymentIntent, PaymentsService } from '../payments/payments.service';

export interface CheckoutResult {
  order: {
    id: string;
    status: OrderStatus;
    totalAmount: string;
    totalWeightG: number;
    shippingFee: string;
    currency: string;
  };
  payment: PaymentIntent;
}

function moneyToCents(value: Prisma.Decimal | string | number): number {
  return Math.round(Number(value) * 100);
}

function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

function shippingItems(
  items: Array<{ quantity: number; variant: { unitWeightGrams: number } | null }>,
): ShippingItemWeight[] {
  return items.flatMap((item) =>
    item.variant
      ? [{ unitWeightGrams: item.variant.unitWeightGrams, quantity: item.quantity }]
      : [],
  );
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly shipping: ShippingService,
    private readonly payments: PaymentsService,
  ) {}

  async checkout(
    customerId: string,
    shippingAddressId: string,
    gateway: PaymentGateway = PaymentGateway.STRIPE,
  ): Promise<CheckoutResult> {
    const address = await this.prisma.address.findUnique({
      where: { id: shippingAddressId },
      select: { id: true, customerId: true },
    });
    if (!address) throw new NotFoundException(`Address ${shippingAddressId} not found`);
    if (address.customerId !== customerId) {
      throw new ForbiddenException('Address does not belong to customer');
    }

    const initialCart = await this.prisma.cartItem.findMany({
      where: { customerId },
      orderBy: { productVariantId: 'asc' },
      include: { variant: true },
    });
    this.assertCartAvailable(initialCart);

    const order = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`SELECT id FROM cart_item WHERE customer_id = ${customerId}::uuid FOR UPDATE`,
      );
      const cartItems = await tx.cartItem.findMany({
        where: { customerId },
        orderBy: { productVariantId: 'asc' },
        include: { variant: true },
      });
      this.assertCartAvailable(cartItems);

      const shippingQuote = await this.shipping.calculate(shippingItems(cartItems));
      const orderItems: Array<{
        productVariantId: string;
        batchId: string;
        quantity: number;
        unitPriceSnapshot: string;
        lineTotal: string;
      }> = [];
      let subtotalCents = 0;

      for (const item of cartItems) {
        if (!item.variant) continue;
        const draws = await this.inventory.decrementForVariant(item.variant.id, item.quantity, tx);
        const unitPriceCents = moneyToCents(item.variant.price);
        for (const draw of draws) {
          const lineTotalCents = unitPriceCents * draw.qtyTaken;
          subtotalCents += lineTotalCents;
          orderItems.push({
            productVariantId: item.variant.id,
            batchId: draw.batchId,
            quantity: draw.qtyTaken,
            unitPriceSnapshot: formatCents(unitPriceCents),
            lineTotal: formatCents(lineTotalCents),
          });
        }
      }

      const shippingFeeCents = moneyToCents(shippingQuote.feeLkr);
      const totalWeightG = shippingQuote.totalWeightG;
      const created = await tx.order.create({
        data: {
          customerId,
          shippingAddressId,
          status: OrderStatus.PENDING_PAYMENT,
          paymentStatus: PaymentStatus.PENDING,
          totalAmount: formatCents(subtotalCents + shippingFeeCents),
          totalWeight: totalWeightG.toFixed(2),
          shippingFee: formatCents(shippingFeeCents),
          currency: 'LKR',
          items: { create: orderItems },
        },
        include: { items: true },
      });

      await tx.cartItem.deleteMany({ where: { customerId } });
      return { created, shippingQuote };
    });

    const payment = await this.payments.createIntent({
      orderId: order.created.id,
      amount: formatCents(moneyToCents(order.created.totalAmount)),
      currency: order.created.currency,
      gateway,
    });

    this.logger.log(
      `Checkout order=${order.created.id} customer=${customerId} total=${order.created.totalAmount} weight=${order.shippingQuote.totalWeightG}g`,
    );
    return {
      order: {
        id: order.created.id,
        status: order.created.status,
        totalAmount: formatCents(moneyToCents(order.created.totalAmount)),
        totalWeightG: order.shippingQuote.totalWeightG,
        shippingFee: formatCents(moneyToCents(order.created.shippingFee)),
        currency: order.created.currency,
      },
      payment,
    };
  }

  async quote(customerId: string) {
    const items = await this.prisma.cartItem.findMany({
      where: { customerId },
      include: {
        variant: { select: { id: true, active: true, unitWeightGrams: true, price: true } },
      },
    });
    if (items.length === 0) {
      return {
        subtotal: '0.00',
        shippingFee: '0.00',
        total: '0.00',
        totalWeightG: 0,
        shippingBracket: null,
      };
    }
    this.assertCartAvailable(items);
    const subtotalCents = items.reduce(
      (total, item) => total + moneyToCents(item.variant!.price) * item.quantity,
      0,
    );
    const shipping = await this.shipping.calculate(shippingItems(items));
    const shippingFeeCents = moneyToCents(shipping.feeLkr);
    return {
      subtotal: formatCents(subtotalCents),
      shippingFee: formatCents(shippingFeeCents),
      total: formatCents(subtotalCents + shippingFeeCents),
      totalWeightG: shipping.totalWeightG,
      shippingBracket: shipping.bracketLabel,
    };
  }

  async getOrder(customerId: string, orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: {
          include: { variant: { select: { name: true, size: true, sku: true } } },
        },
        payments: true,
        shippingAddress: true,
      },
    });
    if (!order) throw new NotFoundException(`Order ${orderId} not found`);
    if (order.customerId !== customerId) throw new ForbiddenException('Not your order');
    return order;
  }

  listForCustomer(customerId: string) {
    return this.prisma.order.findMany({
      where: { customerId },
      orderBy: { placedAt: 'desc' },
      include: {
        items: {
          include: { variant: { select: { name: true, size: true, sku: true } } },
        },
      },
    });
  }

  private assertCartAvailable(
    items: Array<{ productVariantId: string; variant: { id: string; active: boolean } | null }>,
  ): void {
    if (items.length === 0) throw new BadRequestException('Cart is empty');
    for (const item of items) {
      if (!item.variant || !item.variant.active) {
        throw new BadRequestException(
          `Variant ${item.productVariantId} is no longer available — remove it from your cart`,
        );
      }
    }
  }
}
