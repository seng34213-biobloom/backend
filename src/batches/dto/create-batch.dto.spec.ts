import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateBatchDto } from './create-batch.dto';

const valid = {
  batchNumber: 'B-2026-001',
  manufacturedDate: '2026-10-01',
  expiryDate: '2027-01-31',
  initialQuantity: '25',
};

const errorsFor = (body: Record<string, unknown>) =>
  validateSync(plainToInstance(CreateBatchDto, body)).map((e) => e.property);

describe('CreateBatchDto', () => {
  it('accepts a valid batch and converts the quantity to a number', () => {
    expect(errorsFor(valid)).toEqual([]);
    expect(plainToInstance(CreateBatchDto, valid).initialQuantity).toBe(25);
  });

  it.each([
    ['initialQuantity', { initialQuantity: 0 }],
    ['initialQuantity', { initialQuantity: 2.5 }],
    ['manufacturedDate', { manufacturedDate: '01/10/2026' }],
    ['expiryDate', { expiryDate: 'next year' }],
    ['batchNumber', { batchNumber: '' }],
    ['batchNumber', { batchNumber: 'x'.repeat(65) }],
  ])('rejects an invalid %s', (property, override) => {
    expect(errorsFor({ ...valid, ...override })).toContain(property);
  });
});
