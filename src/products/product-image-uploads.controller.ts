import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { PresignProductImageDto } from './dto/product-image.dto';
import { ProductsAdminService } from './products-admin.service';

@Controller('uploads')
export class ProductImageUploadsController {
  constructor(private readonly products: ProductsAdminService) {}

  @Post('product-image')
  @Roles(Role.ADMIN, Role.SELLER)
  @HttpCode(HttpStatus.OK)
  productImage(@Body() dto: PresignProductImageDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.products.presignImage(dto, actor);
  }
}
