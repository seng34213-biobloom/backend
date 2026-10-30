import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { CreatePromoCodeDto, UpdatePromoCodeDto } from './dto/promo-code.dto';
import { PromoCodesService } from './promo-codes.service';

@Controller('admin/promo-codes')
@Roles(Role.ADMIN)
export class PromoCodesController {
  constructor(private readonly promos: PromoCodesService) {}

  @Get()
  list() {
    return this.promos.list();
  }

  @Post()
  create(@Body() dto: CreatePromoCodeDto, @CurrentUser() user: AuthenticatedUser) {
    return this.promos.create(dto, user);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdatePromoCodeDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.promos.update(id, dto, user);
  }
}
