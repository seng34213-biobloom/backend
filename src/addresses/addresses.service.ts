import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateAddressDto } from './dto/create-address.dto';

export interface AddressDto {
  id: string;
  line1: string;
  line2: string | null;
  city: string;
  district: string;
  postalCode: string;
  country: string;
  isDefault: boolean;
  createdAt: Date;
}

@Injectable()
export class AddressesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(customerId: string): Promise<AddressDto[]> {
    const rows = await this.prisma.address.findMany({
      where: { customerId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map((row) => this.toAddressDto(row));
  }

  async create(customerId: string, dto: CreateAddressDto): Promise<AddressDto> {
    const existing = await this.prisma.address.count({ where: { customerId } });
    const makeDefault = dto.isDefault ?? existing === 0;
    const created = await this.prisma.$transaction(async (tx) => {
      if (makeDefault) {
        await tx.address.updateMany({
          where: { customerId, isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.address.create({
        data: {
          customerId,
          line1: dto.line1,
          line2: dto.line2,
          city: dto.city,
          district: dto.district,
          postalCode: dto.postalCode,
          country: dto.country ?? 'LK',
          isDefault: makeDefault,
        },
      });
    });
    return this.toAddressDto(created);
  }

  async setDefault(customerId: string, addressId: string): Promise<AddressDto> {
    const existing = await this.prisma.address.findFirst({
      where: { id: addressId, customerId },
    });
    if (!existing) throw new NotFoundException('Address not found');
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.address.updateMany({
        where: { customerId, isDefault: true },
        data: { isDefault: false },
      });
      return tx.address.update({
        where: { id: addressId },
        data: { isDefault: true },
      });
    });
    return this.toAddressDto(updated);
  }

  private toAddressDto(row: AddressDto): AddressDto {
    return {
      id: row.id,
      line1: row.line1,
      line2: row.line2,
      city: row.city,
      district: row.district,
      postalCode: row.postalCode,
      country: row.country,
      isDefault: row.isDefault,
      createdAt: row.createdAt,
    };
  }
}
