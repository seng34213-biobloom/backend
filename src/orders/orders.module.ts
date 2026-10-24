import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { PaymentsModule } from '../payments/payments.module';
import { ShippingModule } from '../shipping/shipping.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { OrderStatusService } from './order-status.service';

@Module({
  imports: [InventoryModule, PaymentsModule, ShippingModule],
  controllers: [OrdersController],
  providers: [OrdersService, OrderStatusService],
  exports: [OrdersService, OrderStatusService],
})
export class OrdersModule {}
