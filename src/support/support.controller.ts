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
  Query,
} from '@nestjs/common';
import { Role, SupportTicketStatus } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { UpdateTicketStatusDto } from './dto/update-ticket-status.dto';
import { SupportService } from './support.service';

@Controller()
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Roles(Role.CUSTOMER)
  @Post('support/tickets')
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateTicketDto, @CurrentUser() customer: AuthenticatedUser) {
    return this.support.create(customer.id, dto);
  }

  @Roles(Role.CUSTOMER)
  @Get('support/tickets')
  listMine(@CurrentUser() customer: AuthenticatedUser) {
    return this.support.listForCustomer(customer.id);
  }

  @Roles(Role.CUSTOMER)
  @Get('support/tickets/:id')
  getMine(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() customer: AuthenticatedUser,
  ) {
    return this.support.getForCustomer(id, customer.id);
  }

  @Roles(Role.CUSTOMER)
  @Post('support/tickets/:id/reopen')
  @HttpCode(HttpStatus.OK)
  reopen(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() customer: AuthenticatedUser,
  ) {
    return this.support.reopen(id, customer.id);
  }

  @Roles(Role.ADMIN)
  @Get('admin/support/tickets')
  listAdmin(@Query('status') status?: SupportTicketStatus) {
    return this.support.listForAdmin(status);
  }

  @Roles(Role.ADMIN)
  @Post('admin/support/tickets/:id/resolve')
  @HttpCode(HttpStatus.OK)
  resolve(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.support.updateStatus(id, { status: SupportTicketStatus.RESOLVED }, actor);
  }

  @Roles(Role.ADMIN)
  @Post('admin/support/tickets/:id/close')
  @HttpCode(HttpStatus.OK)
  close(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.support.updateStatus(id, { status: SupportTicketStatus.CLOSED }, actor);
  }

  @Roles(Role.ADMIN)
  @Patch('admin/support/tickets/:id/status')
  updateStatus(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateTicketStatusDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.support.updateStatus(id, dto, actor);
  }
}
