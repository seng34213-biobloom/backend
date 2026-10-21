import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateSubscriptionDto } from './create-subscription.dto';

const valid = {
  productVariantId: '3f1c6a3e-8a4b-4c2d-9f0e-1a2b3c4d5e6f',
  shippingAddressId: '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d',
  frequencyDays: 30,
  quantity: 2,
  paymentToken: 'pm_test_123456',
  paymentGateway: 'STRIPE',
};

const errorsFor = (body: Record<string, unknown>) =>
  validateSync(plainToInstance(CreateSubscriptionDto, body)).map((e) => e.property);

describe('CreateSubscriptionDto', () => {
  it('accepts a valid request and defaults quantity to 1', () => {
    expect(errorsFor(valid)).toEqual([]);
    const withoutQuantity: Partial<typeof valid> = { ...valid };
    delete withoutQuantity.quantity;
    expect(plainToInstance(CreateSubscriptionDto, withoutQuantity).quantity).toBe(1);
  });

  it.each([14, 30, 60])('accepts a frequency of %i days', (frequencyDays) => {
    expect(errorsFor({ ...valid, frequencyDays })).toEqual([]);
  });

  it.each([
    ['frequencyDays', { frequencyDays: 7 }],
    ['quantity', { quantity: 0 }],
    ['quantity', { quantity: 11 }],
    ['paymentGateway', { paymentGateway: 'PAYPAL' }],
    ['paymentToken', { paymentToken: 'short' }],
    ['productVariantId', { productVariantId: 'not-a-uuid' }],
  ])('rejects an invalid %s', (property, override) => {
    expect(errorsFor({ ...valid, ...override })).toContain(property);
  });
});
