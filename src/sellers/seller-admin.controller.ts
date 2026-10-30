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
import { Role, SellerStatus } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { SellerService } from './seller.service';
import { RejectDto } from './dto/reject.dto';

/**
 * Admin-only seller management. Mounted under /api/admin/sellers via the
 * global /api prefix. JwtAuthGuard runs globally; RolesGuard then enforces
 * ADMIN. Every mutation lands an AuditLog row (SDS §7.2).
 */
@Controller('admin/sellers')
@Roles(Role.ADMIN)
export class SellerAdminController {
  constructor(private readonly sellers: SellerService) {}

  @Get()
  async list(@Query('status') status?: SellerStatus) {
    const valid = status && (Object.values(SellerStatus) as string[]).includes(status);
    return this.sellers.listAll(valid ? status : undefined);
  }

  @Get('pending')
  async pending() {
    return this.sellers.listPending();
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  async approve(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.sellers.approve(id, admin.id);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  async reject(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: RejectDto,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.sellers.reject(id, admin.id, dto.reason);
  }

  @Post(':id/suspend')
  @HttpCode(HttpStatus.OK)
  async suspend(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: RejectDto,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.sellers.suspend(id, admin.id, dto.reason);
  }

  @Post(':id/reinstate')
  @HttpCode(HttpStatus.OK)
  async reinstate(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.sellers.reinstate(id, admin.id);
  }
}
