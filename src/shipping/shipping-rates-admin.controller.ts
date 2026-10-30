import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { CreateShippingRateDto, UpdateShippingRateDto } from './dto/shipping-rate.dto';
import { ShippingRatesAdminService } from './shipping-rates-admin.service';

@Controller('admin/shipping-rates')
@Roles(Role.ADMIN)
export class ShippingRatesAdminController {
  constructor(private readonly rates: ShippingRatesAdminService) {}

  @Get()
  list() {
    return this.rates.list();
  }

  @Post()
  create(@Body() dto: CreateShippingRateDto, @CurrentUser() user: AuthenticatedUser) {
    return this.rates.create(dto, user);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateShippingRateDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.rates.update(id, dto, user);
  }

  @Delete(':id')
  remove(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.rates.remove(id, user);
  }
}
