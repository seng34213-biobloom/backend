import { Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module';
import { ShippingService } from './shipping.service';

@Module({
  imports: [RedisModule],
  providers: [ShippingService],
  exports: [ShippingService],
})
export class ShippingModule {}
