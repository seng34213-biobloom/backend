import { Module } from '@nestjs/common';
import { CronLockService } from '../common/locks/cron-lock.service';
import { PaymentsModule } from '../payments/payments.module';
import { ShippingModule } from '../shipping/shipping.module';
import { BillingCronService } from './billing-cron.service';
import { SubscriptionsAdminController } from './subscriptions-admin.controller';
import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsService } from './subscriptions.service';
import { TokenCipherService } from './token-cipher.service';

@Module({
  imports: [PaymentsModule, ShippingModule],
  providers: [SubscriptionsService, TokenCipherService, BillingCronService, CronLockService],
  controllers: [SubscriptionsController, SubscriptionsAdminController],
  exports: [SubscriptionsService, TokenCipherService, BillingCronService],
})
export class SubscriptionsModule {}
