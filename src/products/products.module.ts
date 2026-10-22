import { Module } from '@nestjs/common';
import { ProductsAdminController } from './products-admin.controller';
import { ProductsAdminService } from './products-admin.service';
import { ProductsService } from './products.service';
import { ProductsController } from './products.controller';

@Module({
  providers: [ProductsService, ProductsAdminService],
  controllers: [ProductsController, ProductsAdminController],
  exports: [ProductsService, ProductsAdminService],
})
export class ProductsModule {}
