import { Module } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { PayHereGateway } from './gateways/payhere.gateway';
import { StripeGateway } from './gateways/stripe.gateway';

@Module({
  providers: [PaymentsService, StripeGateway, PayHereGateway],
  exports: [PaymentsService],
})
export class PaymentsModule {}
