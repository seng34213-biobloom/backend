import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { DeliveryAdminController } from './delivery-admin.controller';
import { DeliveryService } from './delivery.service';

@Module({
  imports: [NotificationsModule],
  controllers: [DeliveryAdminController],
  providers: [DeliveryService],
  exports: [DeliveryService],
})
export class DeliveryModule {}
