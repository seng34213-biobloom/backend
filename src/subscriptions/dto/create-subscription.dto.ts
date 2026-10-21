import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PaymentGateway } from '@prisma/client';

export class CreateSubscriptionDto {
  @IsUUID('4')
  productVariantId!: string;

  @IsUUID('4')
  shippingAddressId!: string;

  /** SDS §3.2 — only the supported recurring intervals. */
  @Type(() => Number)
  @IsInt()
  @IsIn([14, 30, 60])
  frequencyDays!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  quantity: number = 1;

  /**
   * The opaque gateway token (Stripe payment_method_id / PayHere card token).
   * Encrypted at rest via pgcrypto — never persisted in plaintext (SDS §7.3).
   */
  @IsString()
  @MinLength(8)
  @MaxLength(256)
  paymentToken!: string;

  @IsEnum(PaymentGateway)
  paymentGateway!: PaymentGateway;
}
