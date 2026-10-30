import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { AdminOrdersService } from './admin-orders.service';
import { AdminOrdersQueryDto } from './dto/admin-orders-query.dto';
import { CancelOrderDto } from './dto/cancel-order.dto';

@Controller('admin/orders')
@Roles(Role.ADMIN, Role.FULFILMENT_STAFF)
export class AdminOrdersController {
  constructor(private readonly orders: AdminOrdersService) {}

  @Get()
  list(@Query() query: AdminOrdersQueryDto) {
    return this.orders.list(query);
  }

  @Get(':id')
  get(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.orders.get(id);
  }

  @Post(':id/cancel')
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  cancel(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: CancelOrderDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.orders.cancelByAdmin(id, dto.reason, actor);
  }
}
