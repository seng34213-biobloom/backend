import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { FulfilmentController } from './fulfilment.controller';
import { FulfilmentService } from './fulfilment.service';

@Module({
  imports: [OrdersModule],
  providers: [FulfilmentService],
  controllers: [FulfilmentController],
  exports: [FulfilmentService],
})
export class FulfilmentModule {}
