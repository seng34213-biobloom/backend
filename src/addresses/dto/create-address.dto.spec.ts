import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateAddressDto } from './create-address.dto';

describe('CreateAddressDto', () => {
  const valid = {
    line1: '12 Flower Road',
    city: 'Colombo',
    district: 'Colombo',
    postalCode: '00100',
  };

  it('accepts a valid address and optional address fields', () => {
    const dto = plainToInstance(CreateAddressDto, {
      ...valid,
      line2: 'Apartment 4',
      country: 'LK',
      isDefault: true,
    });
    expect(validateSync(dto)).toHaveLength(0);
  });

  it.each([
    ['missing line1', { line1: '' }],
    ['short postal code', { postalCode: '12' }],
    ['invalid country length', { country: 'LKA' }],
    ['non-boolean default flag', { isDefault: 'yes' }],
  ])('rejects %s', (_label, overrides) => {
    const dto = plainToInstance(CreateAddressDto, { ...valid, ...overrides });
    expect(validateSync(dto).length).toBeGreaterThan(0);
  });
});
