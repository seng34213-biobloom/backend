import { Module } from '@nestjs/common';
import { CronLockService } from '../common/locks/cron-lock.service';
import { InventoryModule } from '../inventory/inventory.module';
import { PaymentsModule } from '../payments/payments.module';
import { ShippingModule } from '../shipping/shipping.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { OrderStatusService } from './order-status.service';
import { StaleOrderCronService } from './stale-order-cron.service';

@Module({
  imports: [InventoryModule, PaymentsModule, ShippingModule],
  controllers: [OrdersController],
  providers: [OrdersService, OrderStatusService, StaleOrderCronService, CronLockService],
  exports: [OrdersService, OrderStatusService],
})
export class OrdersModule {}
