import { PaymentGateway } from '@prisma/client';
import { IsEnum, IsString, IsUrl, MaxLength, MinLength } from 'class-validator';

export class StartPaymentSetupDto {
  @IsEnum(PaymentGateway)
  gateway!: PaymentGateway;

  @IsUrl({ require_tld: false, protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(2048)
  returnUrl!: string;
}

export class CompletePaymentSetupDto {
  @IsEnum(PaymentGateway)
  gateway!: PaymentGateway;

  @IsString()
  @MinLength(8)
  @MaxLength(255)
  sessionId!: string;
}
