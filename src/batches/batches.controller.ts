import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { BatchesService } from './batches.service';
import { CreateBatchDto } from './dto/create-batch.dto';

/**
 * Admin/seller batch management. Mounted under /api/admin/products/...
 * The Roles decorator allows both ADMIN and SELLER; BatchesService then
 * enforces seller-owns-product at the row level.
 */
@Controller('admin/products')
@Roles(Role.ADMIN, Role.SELLER)
export class BatchesController {
  constructor(private readonly batches: BatchesService) {}

  @Get(':productId/batches')
  async list(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.batches.listForProduct(productId, user);
  }

  @Post(':productId/variants/:variantId/batches')
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Param('variantId', new ParseUUIDPipe({ version: '4' })) variantId: string,
    @Body() dto: CreateBatchDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.batches.createForVariant(productId, variantId, dto, user);
  }
}
