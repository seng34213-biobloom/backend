import { Transform } from 'class-transformer';
import { registerDecorator, ValidationOptions } from 'class-validator';

/** Up to 10 integer digits and at most 2 decimals — fits Decimal(12, 2). */
const MONEY_PATTERN = /^\d{1,10}(\.\d{1,2})?$/;

/**
 * Money is accepted as a JSON string ("450.00") or a plain number (450).
 * Numbers are converted to their string form before validation so the
 * service only ever builds `Prisma.Decimal` values from strings.
 */
export function ToMoneyString(): PropertyDecorator {
  return Transform(({ value }: { value: unknown }) =>
    typeof value === 'number' && Number.isFinite(value) ? String(value) : value,
  );
}

function isMoney(value: unknown, allowZero: boolean): boolean {
  if (typeof value !== 'string' || !MONEY_PATTERN.test(value)) return false;
  return allowZero || /[1-9]/.test(value);
}

/** A money amount strictly greater than zero (prices). */
export function IsPositiveMoney(options?: ValidationOptions): PropertyDecorator {
  return (target: object, propertyName: string | symbol) =>
    registerDecorator({
      name: 'isPositiveMoney',
      target: target.constructor,
      propertyName: propertyName as string,
      options: {
        message: `${String(propertyName)} must be an amount greater than 0 with at most 2 decimals`,
        ...options,
      },
      validator: { validate: (value: unknown) => isMoney(value, false) },
    });
}

/** A money amount of zero or more (shipping fees: a free bracket is valid). */
export function IsNonNegativeMoney(options?: ValidationOptions): PropertyDecorator {
  return (target: object, propertyName: string | symbol) =>
    registerDecorator({
      name: 'isNonNegativeMoney',
      target: target.constructor,
      propertyName: propertyName as string,
      options: {
        message: `${String(propertyName)} must be an amount of 0 or more with at most 2 decimals`,
        ...options,
      },
      validator: { validate: (value: unknown) => isMoney(value, true) },
    });
}
