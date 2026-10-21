import { Module } from '@nestjs/common';
import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsService } from './subscriptions.service';
import { TokenCipherService } from './token-cipher.service';

@Module({
  providers: [SubscriptionsService, TokenCipherService],
  controllers: [SubscriptionsController],
  exports: [SubscriptionsService, TokenCipherService],
})
export class SubscriptionsModule {}
