import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { CreateProductDto } from './dto/create-product.dto';
import { CreateVariantDto } from './dto/create-variant.dto';
import { ListAdminProductsQueryDto } from './dto/list-admin-products-query.dto';
import { AddProductImageDto } from './dto/product-image.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { UpdateVariantDto } from './dto/update-variant.dto';
import { ProductsAdminService } from './products-admin.service';

@Controller('admin/products')
@Roles(Role.ADMIN, Role.SELLER)
export class ProductsAdminController {
  constructor(private readonly products: ProductsAdminService) {}

  @Get()
  list(@Query() query: ListAdminProductsQueryDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.products.list(query, actor);
  }

  @Get(':productId')
  get(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.products.get(productId, actor);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateProductDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.products.createProduct(dto, actor);
  }

  @Patch(':productId')
  update(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Body() dto: UpdateProductDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.products.updateProduct(productId, dto, actor);
  }

  @Post(':productId/images')
  @HttpCode(HttpStatus.CREATED)
  addImage(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Body() dto: AddProductImageDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.products.addImage(productId, dto, actor);
  }

  @Delete(':productId/images/:imageId')
  removeImage(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Param('imageId', new ParseUUIDPipe({ version: '4' })) imageId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.products.removeImage(productId, imageId, actor);
  }

  @Post(':productId/variants')
  @HttpCode(HttpStatus.CREATED)
  createVariant(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Body() dto: CreateVariantDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.products.createVariant(productId, dto, actor);
  }

  @Patch(':productId/variants/:variantId')
  updateVariant(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Param('variantId', new ParseUUIDPipe({ version: '4' })) variantId: string,
    @Body() dto: UpdateVariantDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.products.updateVariant(productId, variantId, dto, actor);
  }

  @Delete(':productId')
  deactivateProduct(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.products.deactivateProduct(productId, actor);
  }

  @Delete(':productId/variants/:variantId')
  deactivateVariant(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Param('variantId', new ParseUUIDPipe({ version: '4' })) variantId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.products.deactivateVariant(productId, variantId, actor);
  }
}
