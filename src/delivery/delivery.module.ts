import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OrdersModule } from '../orders/orders.module';
import { DeliveryController } from './delivery.controller';
import { DeliveryAdminController } from './delivery-admin.controller';
import { DeliveryService } from './delivery.service';
import { RidersAdminController } from './riders-admin.controller';
import { RidersService } from './riders.service';

@Module({
  imports: [AuthModule, NotificationsModule, OrdersModule],
  controllers: [DeliveryAdminController, DeliveryController, RidersAdminController],
  providers: [DeliveryService, RidersService],
  exports: [DeliveryService],
})
export class DeliveryModule {}
