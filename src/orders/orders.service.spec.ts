import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { OrderStatus, PaymentGateway, PaymentStatus, Prisma } from '@prisma/client';
import { InventoryService } from '../inventory/inventory.service';
import { OutOfStockError } from '../inventory/inventory.errors';
import { PaymentsService } from '../payments/payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { ShippingService } from '../shipping/shipping.service';
import { OrdersService } from './orders.service';

const cartItem = {
  id: 'cart-1',
  customerId: 'customer-1',
  productVariantId: 'variant-1',
  quantity: 2,
  variant: {
    id: 'variant-1',
    active: true,
    price: '1500.00',
    unitWeightGrams: 300,
  },
};

describe('OrdersService', () => {
  let service: OrdersService;
  let prisma: jest.Mocked<PrismaService>;
  let inventory: jest.Mocked<InventoryService>;
  let shipping: jest.Mocked<ShippingService>;
  let payments: jest.Mocked<PaymentsService>;
  let tx: {
    $queryRaw: jest.Mock;
    cartItem: { findMany: jest.Mock; deleteMany: jest.Mock };
    order: { create: jest.Mock };
  };

  beforeEach(() => {
    tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      cartItem: {
        findMany: jest.fn().mockResolvedValue([cartItem]),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      order: {
        create: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({
            id: 'order-1',
            status: data.status,
            paymentStatus: data.paymentStatus,
            totalAmount: data.totalAmount,
            totalWeight: data.totalWeight,
            shippingFee: data.shippingFee,
            currency: data.currency,
            items: [],
          }),
        ),
      },
    };
    prisma = {
      address: {
        findUnique: jest.fn().mockResolvedValue({ id: 'address-1', customerId: 'customer-1' }),
      },
      cartItem: { findMany: jest.fn().mockResolvedValue([cartItem]) },
      order: { findUnique: jest.fn(), findMany: jest.fn() },
      $transaction: jest.fn((work: (transaction: unknown) => unknown) => work(tx)),
    } as unknown as jest.Mocked<PrismaService>;
    inventory = {
      decrementForVariant: jest
        .fn()
        .mockResolvedValue([{ batchId: 'batch-1', qtyTaken: 2, depleted: false }]),
    } as unknown as jest.Mocked<InventoryService>;
    shipping = {
      calculate: jest.fn().mockResolvedValue({
        totalWeightG: 600,
        feeLkr: '500.00',
        bracketId: 'rate-1',
        bracketLabel: '501 g - 1 kg',
      }),
    } as unknown as jest.Mocked<ShippingService>;
    payments = {
      assertCheckoutAvailable: jest.fn().mockResolvedValue(undefined),
      createIntent: jest.fn().mockResolvedValue({
        gateway: PaymentGateway.STRIPE,
        gatewayPaymentId: 'pi_test_abc',
        clientSecret: 'secret',
        amount: '3500.00',
        currency: 'LKR',
      }),
    } as unknown as jest.Mocked<PaymentsService>;
    service = new OrdersService(prisma, inventory, shipping, payments);
  });

  it('stops before touching the cart when the gateway cannot take the payment', async () => {
    (payments.assertCheckoutAvailable as jest.Mock).mockRejectedValue(
      new Error('PayHere is not available'),
    );

    await expect(service.checkout('customer-1', 'address-1')).rejects.toThrow('PayHere');

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(payments.createIntent).not.toHaveBeenCalled();
  });

  it('summarises a customer order list', async () => {
    (prisma.order.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'order-1',
        orderNumber: 7,
        placedAt: new Date('2026-10-30'),
        status: 'PAID',
        totalAmount: new Prisma.Decimal('1000'),
        _count: { items: 2 },
      },
    ]);

    await expect(service.listForCustomer('customer-1')).resolves.toEqual([
      expect.objectContaining({ orderNumber: 7, totalAmount: '1000.00', itemCount: 2 }),
    ]);
  });

  it('builds the customer order page and refuses other customers', async () => {
    (prisma.order.findUnique as jest.Mock).mockResolvedValue({
      id: 'order-1',
      orderNumber: 7,
      customerId: 'customer-1',
      status: 'PAID',
      totalAmount: new Prisma.Decimal('1000'),
      totalWeight: new Prisma.Decimal('500'),
      shippingFee: new Prisma.Decimal('200'),
      items: [
        {
          id: 'item-1',
          quantity: 2,
          unitPriceSnapshot: new Prisma.Decimal('400'),
          lineTotal: new Prisma.Decimal('800'),
          variant: { name: 'Jam', size: '250g', sku: 'S', product: { name: 'Strawberry Jam' } },
        },
      ],
      payments: [
        { id: 'p1', gateway: 'STRIPE', status: 'REFUNDED', amount: new Prisma.Decimal('1000') },
        { id: 'p2', gateway: 'STRIPE', status: 'PAID', amount: new Prisma.Decimal('1000') },
      ],
      refundRequests: [{ id: 'r1', amount: new Prisma.Decimal('100') }],
      deliveryAssignment: { status: 'ASSIGNED', deliveryUser: { name: 'Rider' } },
    });

    const out = await service.getOrder('customer-1', 'order-1');

    expect(out).toMatchObject({ subtotal: '800.00', discountAmount: '0.00', totalWeightG: 500 });
    expect(out.items[0]).toMatchObject({ productName: 'Strawberry Jam', lineTotal: '800.00' });
    expect(out.payments.map((p) => p.refundedAmount)).toEqual(['1000.00', '0.00']);
    expect(out.payments[0]).not.toHaveProperty('rawPayload');
    expect(out.refundRequests[0].amount).toBe('100.00');
    expect(out.delivery?.riderName).toBe('Rider');
    await expect(service.getOrder('someone-else', 'order-1')).rejects.toThrow('Not your order');
  });

  it('returns an empty quote without requiring shipping rates', async () => {
    (prisma.cartItem.findMany as jest.Mock).mockResolvedValue([]);

    await expect(service.quote('customer-1')).resolves.toEqual({
      subtotal: '0.00',
      shippingFee: '0.00',
      total: '0.00',
      totalWeightG: 0,
      shippingBracket: null,
    });
    expect(shipping.calculate).not.toHaveBeenCalled();
  });

  it('quotes subtotal, shipping fee, bracket, total, and total weight', async () => {
    await expect(service.quote('customer-1')).resolves.toEqual({
      subtotal: '3000.00',
      shippingFee: '500.00',
      total: '3500.00',
      totalWeightG: 600,
      shippingBracket: '501 g - 1 kg',
    });
  });

  it('creates a pending order, snapshots FIFO draws, clears the cart, and creates an intent', async () => {
    const result = await service.checkout('customer-1', 'address-1');

    expect(result.order).toEqual({
      id: 'order-1',
      status: OrderStatus.PENDING_PAYMENT,
      totalAmount: '3500.00',
      totalWeightG: 600,
      shippingFee: '500.00',
      currency: 'LKR',
    });
    expect(tx.order.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        customerId: 'customer-1',
        shippingAddressId: 'address-1',
        status: OrderStatus.PENDING_PAYMENT,
        paymentStatus: PaymentStatus.PENDING,
        totalAmount: '3500.00',
        totalWeight: '600.00',
        shippingFee: '500.00',
        items: {
          create: [
            {
              productVariantId: 'variant-1',
              batchId: 'batch-1',
              quantity: 2,
              unitPriceSnapshot: '1500.00',
              lineTotal: '3000.00',
            },
          ],
        },
      }),
      include: { items: true },
    });
    expect(tx.cartItem.deleteMany).toHaveBeenCalledWith({ where: { customerId: 'customer-1' } });
    expect(payments.createIntent).toHaveBeenCalledWith({
      orderId: 'order-1',
      amount: '3500.00',
      currency: 'LKR',
      gateway: PaymentGateway.STRIPE,
    });
  });

  it('rejects an unknown or foreign shipping address before opening a transaction', async () => {
    (prisma.address.findUnique as jest.Mock).mockResolvedValue(null);
    await expect(service.checkout('customer-1', 'missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );

    (prisma.address.findUnique as jest.Mock).mockResolvedValue({
      id: 'address-2',
      customerId: 'customer-2',
    });
    await expect(service.checkout('customer-1', 'address-2')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects an empty cart and inactive variants without creating an order', async () => {
    (prisma.cartItem.findMany as jest.Mock).mockResolvedValue([]);
    await expect(service.checkout('customer-1', 'address-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );

    (prisma.cartItem.findMany as jest.Mock).mockResolvedValue([
      { ...cartItem, variant: { ...cartItem.variant, active: false } },
    ]);
    await expect(service.checkout('customer-1', 'address-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(tx.order.create).not.toHaveBeenCalled();
  });

  it('does not create an order when no shipping rate covers the cart weight', async () => {
    shipping.calculate.mockRejectedValue(
      new NotFoundException('No shipping rate covers weight 2001 g'),
    );

    await expect(service.checkout('customer-1', 'address-1')).rejects.toThrow(
      'No shipping rate covers weight 2001 g',
    );

    expect(tx.order.create).not.toHaveBeenCalled();
    expect(tx.cartItem.deleteMany).not.toHaveBeenCalled();
    expect(inventory.decrementForVariant).not.toHaveBeenCalled();
    expect(payments.createIntent).not.toHaveBeenCalled();
  });

  it('does not create an order, clear the cart, or charge when FIFO stock loses a race', async () => {
    inventory.decrementForVariant.mockRejectedValue(new OutOfStockError('variant-1', 2, 0));

    await expect(service.checkout('customer-1', 'address-1')).rejects.toBeInstanceOf(
      OutOfStockError,
    );
    expect(tx.order.create).not.toHaveBeenCalled();
    expect(tx.cartItem.deleteMany).not.toHaveBeenCalled();
    expect(payments.createIntent).not.toHaveBeenCalled();
  });
});
