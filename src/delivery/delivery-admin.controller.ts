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
import { AssignDeliveryDto } from './dto/assign-delivery.dto';
import { AssignOrderDto } from './dto/assign-order.dto';
import { ListAssignmentsQueryDto } from './dto/list-assignments.dto';
import { DeliveryService } from './delivery.service';

@Controller('admin')
@Roles(Role.ADMIN, Role.FULFILMENT_STAFF)
export class DeliveryAdminController {
  constructor(private readonly delivery: DeliveryService) {}

  @Post('delivery/assignments')
  @HttpCode(HttpStatus.CREATED)
  assign(@Body() dto: AssignDeliveryDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.delivery.assign(dto, actor);
  }

  @Post('orders/:id/assign')
  @HttpCode(HttpStatus.CREATED)
  assignOrder(
    @Param('id', new ParseUUIDPipe({ version: '4' })) orderId: string,
    @Body() dto: AssignOrderDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.delivery.assign({ orderId, deliveryUserId: dto.deliveryUserId }, actor);
  }

  @Get('delivery-assignments')
  list(@Query() query: ListAssignmentsQueryDto) {
    return this.delivery.listForAdmin(query);
  }
}
