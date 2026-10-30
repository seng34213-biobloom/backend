import { Module } from '@nestjs/common';
import { BundlesAdminController } from './bundles-admin.controller';
import { BundlesController } from './bundles.controller';
import { BundlesService } from './bundles.service';

@Module({
  controllers: [BundlesController, BundlesAdminController],
  providers: [BundlesService],
})
export class BundlesModule {}
