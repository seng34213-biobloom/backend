import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AddressesService } from './addresses.service';

const addressRow = {
  id: 'address-1',
  customerId: 'customer-1',
  line1: '12 Flower Road',
  line2: null,
  city: 'Colombo',
  district: 'Colombo',
  postalCode: '00100',
  country: 'LK',
  isDefault: true,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

describe('AddressesService', () => {
  let service: AddressesService;
  let prisma: jest.Mocked<PrismaService>;

  beforeEach(() => {
    const mock = {
      address: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([addressRow]),
        findFirst: jest.fn().mockResolvedValue(addressRow),
        create: jest.fn().mockResolvedValue(addressRow),
        update: jest.fn().mockResolvedValue(addressRow),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    Object.assign(mock, {
      $transaction: jest.fn((work: (tx: unknown) => unknown) => work(mock)),
    });
    prisma = mock as unknown as jest.Mocked<PrismaService>;
    service = new AddressesService(prisma);
  });

  it('lists a customer’s addresses with defaults first', async () => {
    await expect(service.list('customer-1')).resolves.toEqual([
      expect.objectContaining({ id: 'address-1', isDefault: true }),
    ]);
    expect(prisma.address.findMany).toHaveBeenCalledWith({
      where: { customerId: 'customer-1' },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
  });

  it('makes the first address default and persists the customer ownership', async () => {
    const result = await service.create('customer-1', {
      line1: '12 Flower Road',
      city: 'Colombo',
      district: 'Colombo',
      postalCode: '00100',
    });

    expect(prisma.address.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        customerId: 'customer-1',
        country: 'LK',
        isDefault: true,
      }),
    });
    expect(result.id).toBe('address-1');
  });

  it('clears the previous default before setting another address as default', async () => {
    (prisma.address.count as jest.Mock).mockResolvedValue(2);
    (prisma.address.create as jest.Mock).mockResolvedValue({
      ...addressRow,
      id: 'address-2',
      isDefault: true,
    });

    await service.create('customer-1', {
      line1: '8 Lake Road',
      city: 'Colombo',
      district: 'Colombo',
      postalCode: '00200',
      isDefault: true,
    });

    expect(prisma.address.updateMany).toHaveBeenCalledWith({
      where: { customerId: 'customer-1', isDefault: true },
      data: { isDefault: false },
    });
  });

  it('does not set another customer’s address as default', async () => {
    (prisma.address.findFirst as jest.Mock).mockResolvedValue(null);

    await expect(service.setDefault('customer-1', 'address-foreign')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.address.update).not.toHaveBeenCalled();
  });
});
