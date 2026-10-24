import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { PaymentsModule } from '../payments/payments.module';
import { RefundsController } from './refunds.controller';
import { RefundsService } from './refunds.service';

@Module({
  imports: [OrdersModule, PaymentsModule],
  providers: [RefundsService],
  controllers: [RefundsController],
  exports: [RefundsService],
})
export class RefundsModule {}
