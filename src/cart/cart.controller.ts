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
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { CartService } from './cart.service';
import { AddCartItemDto } from './dto/add-item.dto';
import { UpdateCartItemDto } from './dto/update-item.dto';

@Controller('cart')
@Roles(Role.CUSTOMER)
export class CartController {
  constructor(private readonly cart: CartService) {}

  @Get()
  get(@CurrentUser() user: AuthenticatedUser) {
    return this.cart.getCart(user.id);
  }

  @Post('items')
  @HttpCode(HttpStatus.OK)
  add(@Body() dto: AddCartItemDto, @CurrentUser() user: AuthenticatedUser) {
    return this.cart.addItem(user.id, dto);
  }

  @Patch('items/:itemId')
  update(
    @Param('itemId', new ParseUUIDPipe({ version: '4' })) itemId: string,
    @Body() dto: UpdateCartItemDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.cart.updateItem(user.id, itemId, dto.quantity);
  }

  @Delete('items/:itemId')
  remove(
    @Param('itemId', new ParseUUIDPipe({ version: '4' })) itemId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.cart.removeItem(user.id, itemId);
  }
}
