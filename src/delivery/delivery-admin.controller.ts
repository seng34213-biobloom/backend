import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { AssignDeliveryDto } from './dto/assign-delivery.dto';
import { DeliveryService } from './delivery.service';

@Controller('admin/delivery')
@Roles(Role.ADMIN, Role.FULFILMENT_STAFF)
export class DeliveryAdminController {
  constructor(private readonly delivery: DeliveryService) {}

  @Post('assignments')
  @HttpCode(HttpStatus.CREATED)
  assign(@Body() dto: AssignDeliveryDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.delivery.assign(dto, actor);
  }
}
