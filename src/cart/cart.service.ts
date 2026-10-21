import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import type { AddCartItemDto } from './dto/add-item.dto';

export interface CartLine {
  id: string;
  quantity: number;
  variant: {
    id: string;
    sku: string;
    name: string;
    size: string;
    price: string;
    unitWeightGrams: number;
    productId: string;
    productName: string;
    productSlug: string;
  };
  available: number;
  lineSubtotal: string;
}

export interface CartView {
  items: CartLine[];
  itemCount: number;
  subtotal: string;
  totalWeightG: number;
}

@Injectable()
export class CartService {
  private readonly logger = new Logger(CartService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
  ) {}

  async getCart(customerId: string): Promise<CartView> {
    const items = await this.prisma.cartItem.findMany({
      where: { customerId },
      orderBy: { addedAt: 'asc' },
      include: {
        variant: {
          include: {
            product: { select: { id: true, name: true, slug: true } },
          },
        },
      },
    });

    const lines: CartLine[] = [];
    let subtotalNum = 0;
    let totalWeightG = 0;
    for (const row of items) {
      const available = await this.inventory.availableStock(row.variant.id);
      const lineSubtotal = Number(row.variant.price) * row.quantity;
      subtotalNum += lineSubtotal;
      totalWeightG += row.variant.unitWeightGrams * row.quantity;
      lines.push({
        id: row.id,
        quantity: row.quantity,
        variant: {
          id: row.variant.id,
          sku: row.variant.sku,
          name: row.variant.name,
          size: row.variant.size,
          price: row.variant.price.toString(),
          unitWeightGrams: row.variant.unitWeightGrams,
          productId: row.variant.product.id,
          productName: row.variant.product.name,
          productSlug: row.variant.product.slug,
        },
        available,
        lineSubtotal: lineSubtotal.toFixed(2),
      });
    }

    return {
      items: lines,
      itemCount: lines.reduce((acc, line) => acc + line.quantity, 0),
      subtotal: subtotalNum.toFixed(2),
      totalWeightG,
    };
  }

  async addItem(customerId: string, dto: AddCartItemDto): Promise<CartView> {
    const variant = await this.prisma.productVariant.findUnique({
      where: { id: dto.productVariantId },
      select: { id: true, active: true },
    });
    if (!variant || !variant.active) {
      throw new NotFoundException(`Variant ${dto.productVariantId} not found`);
    }

    const existing = await this.prisma.cartItem.findUnique({
      where: {
        customerId_productVariantId: { customerId, productVariantId: dto.productVariantId },
      },
    });
    const newQty = (existing?.quantity ?? 0) + dto.quantity;

    const stock = await this.inventory.checkStock(dto.productVariantId, newQty);
    if (!stock.sufficient) {
      throw new ConflictException(
        `Only ${stock.available} units available; cannot add ${dto.quantity} (cart would total ${newQty})`,
      );
    }

    await this.prisma.cartItem.upsert({
      where: {
        customerId_productVariantId: { customerId, productVariantId: dto.productVariantId },
      },
      update: { quantity: newQty },
      create: {
        customerId,
        productVariantId: dto.productVariantId,
        quantity: dto.quantity,
      },
    });
    this.logger.log(
      `Cart add: customer=${customerId} variant=${dto.productVariantId} qty=${newQty}`,
    );
    return this.getCart(customerId);
  }

  async updateItem(customerId: string, itemId: string, quantity: number): Promise<CartView> {
    const item = await this.prisma.cartItem.findUnique({ where: { id: itemId } });
    if (!item) throw new NotFoundException(`Cart item ${itemId} not found`);
    if (item.customerId !== customerId) throw new ForbiddenException('Not your cart item');

    if (quantity === 0) {
      await this.prisma.cartItem.delete({ where: { id: itemId } });
      return this.getCart(customerId);
    }

    const stock = await this.inventory.checkStock(item.productVariantId, quantity);
    if (!stock.sufficient) {
      throw new ConflictException(
        `Only ${stock.available} units available; cannot set quantity to ${quantity}`,
      );
    }
    await this.prisma.cartItem.update({
      where: { id: itemId },
      data: { quantity },
    });
    return this.getCart(customerId);
  }

  async removeItem(customerId: string, itemId: string): Promise<CartView> {
    const item = await this.prisma.cartItem.findUnique({ where: { id: itemId } });
    if (!item) throw new NotFoundException(`Cart item ${itemId} not found`);
    if (item.customerId !== customerId) throw new ForbiddenException('Not your cart item');
    await this.prisma.cartItem.delete({ where: { id: itemId } });
    return this.getCart(customerId);
  }

  async clearCart(customerId: string, tx: Prisma.TransactionClient | PrismaService): Promise<void> {
    await tx.cartItem.deleteMany({ where: { customerId } });
  }
}
