import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SellerService } from './seller.service';
import { SellerController } from './seller.controller';
import { SellerAdminController } from './seller-admin.controller';

@Module({
  imports: [AuthModule],
  providers: [SellerService],
  controllers: [SellerController, SellerAdminController],
  exports: [SellerService],
})
export class SellerModule {}
