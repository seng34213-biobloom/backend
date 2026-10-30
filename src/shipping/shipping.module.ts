import { Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module';
import { ShippingRatesAdminController } from './shipping-rates-admin.controller';
import { ShippingRatesAdminService } from './shipping-rates-admin.service';
import { ShippingService } from './shipping.service';

@Module({
  imports: [RedisModule],
  controllers: [ShippingRatesAdminController],
  providers: [ShippingService, ShippingRatesAdminService],
  exports: [ShippingService],
})
export class ShippingModule {}
