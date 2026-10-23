import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { PaymentGateway } from '@prisma/client';

export class CheckoutDto {
  @IsUUID('4')
  shippingAddressId!: string;

  @IsOptional()
  @IsEnum(PaymentGateway)
  gateway?: PaymentGateway;
}
