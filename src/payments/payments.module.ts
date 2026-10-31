import { Module } from '@nestjs/common';
import { PaymentSetupController, PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PayHereGateway } from './gateways/payhere.gateway';
import { StripeGateway } from './gateways/stripe.gateway';

@Module({
  providers: [PaymentsService, StripeGateway, PayHereGateway],
  controllers: [PaymentsController, PaymentSetupController],
  exports: [PaymentsService],
})
export class PaymentsModule {}
