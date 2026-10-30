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
  Query,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { BundlesService } from './bundles.service';
import { CreateBundleDto, ListAdminBundlesQueryDto, UpdateBundleDto } from './dto/bundle.dto';

const uuid = new ParseUUIDPipe({ version: '4' });

/**
 * Bundle management for admins (all bundles) and sellers (their own).
 * DELETE deactivates; order history keeps its bundle references.
 */
@Controller('admin/bundles')
@Roles(Role.ADMIN, Role.SELLER)
export class BundlesAdminController {
  constructor(private readonly bundles: BundlesService) {}

  @Get()
  list(@Query() query: ListAdminBundlesQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.bundles.listAdmin(query, user);
  }

  @Get(':id')
  get(@Param('id', uuid) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.bundles.getAdmin(id, user);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateBundleDto, @CurrentUser() user: AuthenticatedUser) {
    return this.bundles.create(dto, user);
  }

  @Patch(':id')
  update(
    @Param('id', uuid) id: string,
    @Body() dto: UpdateBundleDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.bundles.update(id, dto, user);
  }

  @Delete(':id')
  deactivate(@Param('id', uuid) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.bundles.deactivate(id, user);
  }
}
