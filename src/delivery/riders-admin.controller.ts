import {
  Body,
  Controller,
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
import { RidersService } from './riders.service';
import { CreateRiderDto, UpdateRiderDto } from './dto/rider.dto';

/** Rider accounts — staff read, admins manage. Mounted under /api/admin/riders. */
@Controller('admin/riders')
@Roles(Role.ADMIN)
export class RidersAdminController {
  constructor(private readonly riders: RidersService) {}

  @Get()
  @Roles(Role.ADMIN, Role.FULFILMENT_STAFF)
  list() {
    return this.riders.list();
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateRiderDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.riders.create(dto, actor);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateRiderDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.riders.update(id, dto, actor);
  }
}
