import { Module } from '@nestjs/common';
import { UploadsModule } from '../uploads/uploads.module';
import { ProductImageUploadsController } from './product-image-uploads.controller';
import { ProductsAdminController } from './products-admin.controller';
import { ProductsAdminService } from './products-admin.service';
import { ProductsService } from './products.service';
import { ProductsController } from './products.controller';

@Module({
  imports: [UploadsModule],
  providers: [ProductsService, ProductsAdminService],
  controllers: [ProductsController, ProductsAdminController, ProductImageUploadsController],
  exports: [ProductsService, ProductsAdminService],
})
export class ProductsModule {}
