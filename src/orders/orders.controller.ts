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
import { PaymentGateway, Role } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { AdminOrdersService } from './admin-orders.service';
import { CheckoutDto } from './dto/checkout.dto';
import { OrdersService } from './orders.service';

@Controller()
@Roles(Role.CUSTOMER)
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly adminOrders: AdminOrdersService,
  ) {}

  @Get('checkout/quote')
  quote(@CurrentUser() user: AuthenticatedUser) {
    return this.orders.quote(user.id);
  }

  @Post('checkout')
  @HttpCode(HttpStatus.CREATED)
  checkout(@Body() dto: CheckoutDto, @CurrentUser() user: AuthenticatedUser) {
    return this.orders.checkout(
      user.id,
      dto.shippingAddressId,
      dto.gateway ?? PaymentGateway.STRIPE,
    );
  }

  @Get('orders')
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.orders.listForCustomer(user.id);
  }

  @Get('orders/:id')
  detail(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.orders.getOrder(user.id, id);
  }

  @Post('orders/:id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.adminOrders.cancelUnpaid(id, user);
    return this.orders.getOrder(user.id, id);
  }
}
