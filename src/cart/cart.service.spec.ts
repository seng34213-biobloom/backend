import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { CartService } from './cart.service';

describe('CartService', () => {
  let service: CartService;
  let prisma: jest.Mocked<PrismaService>;
  let inventory: jest.Mocked<Pick<InventoryService, 'availableStock' | 'checkStock'>>;

  const row = {
    id: 'cart-item-1',
    customerId: 'customer-1',
    productVariantId: 'variant-1',
    quantity: 2,
    addedAt: new Date('2026-01-01T00:00:00.000Z'),
    variant: {
      id: 'variant-1',
      sku: 'HONEY-250',
      name: 'Wild Honey',
      size: '250g',
      price: '1250.00',
      unitWeightGrams: 250,
      product: { id: 'product-1', name: 'Wild Honey', slug: 'wild-honey' },
    },
  };

  beforeEach(() => {
    prisma = {
      cartItem: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue(row),
        update: jest.fn().mockResolvedValue(row),
        delete: jest.fn().mockResolvedValue(row),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      productVariant: {
        findUnique: jest.fn().mockResolvedValue({ id: 'variant-1', active: true }),
      },
    } as unknown as jest.Mocked<PrismaService>;
    inventory = {
      availableStock: jest.fn().mockResolvedValue(10),
      checkStock: jest.fn().mockResolvedValue({ available: 10, sufficient: true }),
    };
    service = new CartService(prisma, inventory as unknown as InventoryService);
  });

  it('returns an empty cart with zero totals', async () => {
    await expect(service.getCart('customer-1')).resolves.toEqual({
      items: [],
      itemCount: 0,
      subtotal: '0.00',
      totalWeightG: 0,
    });
  });

  it('maps cart lines and calculates subtotal and total weight', async () => {
    (prisma.cartItem.findMany as jest.Mock).mockResolvedValue([row]);

    await expect(service.getCart('customer-1')).resolves.toEqual({
      items: [
        {
          id: 'cart-item-1',
          quantity: 2,
          variant: {
            id: 'variant-1',
            sku: 'HONEY-250',
            name: 'Wild Honey',
            size: '250g',
            price: '1250.00',
            unitWeightGrams: 250,
            productId: 'product-1',
            productName: 'Wild Honey',
            productSlug: 'wild-honey',
          },
          available: 10,
          lineSubtotal: '2500.00',
        },
      ],
      itemCount: 2,
      subtotal: '2500.00',
      totalWeightG: 500,
    });
    expect(inventory.availableStock).toHaveBeenCalledWith('variant-1');
  });

  describe('addItem', () => {
    it('adds quantity to an existing line when stock permits', async () => {
      (prisma.cartItem.findUnique as jest.Mock).mockResolvedValue({ ...row, quantity: 2 });

      await service.addItem('customer-1', { productVariantId: 'variant-1', quantity: 3 });

      expect(inventory.checkStock).toHaveBeenCalledWith('variant-1', 5);
      expect(prisma.cartItem.upsert).toHaveBeenCalledWith({
        where: {
          customerId_productVariantId: {
            customerId: 'customer-1',
            productVariantId: 'variant-1',
          },
        },
        update: { quantity: 5 },
        create: { customerId: 'customer-1', productVariantId: 'variant-1', quantity: 3 },
      });
    });

    it('rejects a missing or inactive variant', async () => {
      (prisma.productVariant.findUnique as jest.Mock).mockResolvedValueOnce(null);
      await expect(
        service.addItem('customer-1', { productVariantId: 'missing', quantity: 1 }),
      ).rejects.toBeInstanceOf(NotFoundException);

      (prisma.productVariant.findUnique as jest.Mock).mockResolvedValueOnce({
        id: 'variant-1',
        active: false,
      });
      await expect(
        service.addItem('customer-1', { productVariantId: 'variant-1', quantity: 1 }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.cartItem.upsert).not.toHaveBeenCalled();
    });

    it('rejects an addition that would exceed available stock', async () => {
      inventory.checkStock.mockResolvedValue({ available: 3, sufficient: false });

      await expect(
        service.addItem('customer-1', { productVariantId: 'variant-1', quantity: 4 }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.cartItem.upsert).not.toHaveBeenCalled();
    });
  });

  describe('updateItem', () => {
    beforeEach(() => {
      (prisma.cartItem.findUnique as jest.Mock).mockResolvedValue(row);
    });

    it('updates the requested quantity when stock permits', async () => {
      await service.updateItem('customer-1', 'cart-item-1', 4);

      expect(inventory.checkStock).toHaveBeenCalledWith('variant-1', 4);
      expect(prisma.cartItem.update).toHaveBeenCalledWith({
        where: { id: 'cart-item-1' },
        data: { quantity: 4 },
      });
    });

    it('removes a line when quantity is zero', async () => {
      await service.updateItem('customer-1', 'cart-item-1', 0);

      expect(prisma.cartItem.delete).toHaveBeenCalledWith({ where: { id: 'cart-item-1' } });
      expect(inventory.checkStock).not.toHaveBeenCalled();
    });

    it('rejects unknown and non-owned cart items', async () => {
      (prisma.cartItem.findUnique as jest.Mock).mockResolvedValueOnce(null);
      await expect(service.updateItem('customer-1', 'missing', 1)).rejects.toBeInstanceOf(
        NotFoundException,
      );

      (prisma.cartItem.findUnique as jest.Mock).mockResolvedValueOnce({
        ...row,
        customerId: 'customer-2',
      });
      await expect(service.updateItem('customer-1', 'cart-item-1', 1)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.cartItem.update).not.toHaveBeenCalled();
    });

    it('rejects a quantity that exceeds available stock', async () => {
      inventory.checkStock.mockResolvedValue({ available: 3, sufficient: false });

      await expect(service.updateItem('customer-1', 'cart-item-1', 4)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.cartItem.update).not.toHaveBeenCalled();
    });
  });

  describe('removeItem', () => {
    it('removes a cart line owned by the customer', async () => {
      (prisma.cartItem.findUnique as jest.Mock).mockResolvedValue(row);

      await service.removeItem('customer-1', 'cart-item-1');

      expect(prisma.cartItem.delete).toHaveBeenCalledWith({ where: { id: 'cart-item-1' } });
    });

    it('rejects attempts to remove another customer’s line', async () => {
      (prisma.cartItem.findUnique as jest.Mock).mockResolvedValue({
        ...row,
        customerId: 'customer-2',
      });

      await expect(service.removeItem('customer-1', 'cart-item-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.cartItem.delete).not.toHaveBeenCalled();
    });

    it('rejects an unknown cart line', async () => {
      await expect(service.removeItem('customer-1', 'missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  it('clears the customer’s cart using the supplied transaction client', async () => {
    const transaction = { cartItem: { deleteMany: jest.fn().mockResolvedValue({ count: 2 }) } };

    await service.clearCart('customer-1', transaction as never);

    expect(transaction.cartItem.deleteMany).toHaveBeenCalledWith({
      where: { customerId: 'customer-1' },
    });
  });
});
