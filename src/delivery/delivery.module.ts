import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { OrdersModule } from '../orders/orders.module';
import { DeliveryController } from './delivery.controller';
import { DeliveryAdminController } from './delivery-admin.controller';
import { DeliveryService } from './delivery.service';

@Module({
  imports: [NotificationsModule, OrdersModule],
  controllers: [DeliveryAdminController, DeliveryController],
  providers: [DeliveryService],
  exports: [DeliveryService],
})
export class DeliveryModule {}
