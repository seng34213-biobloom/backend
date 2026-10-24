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
import { RefundStatus, Role } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { CreateRefundRequestDto, RejectRefundDto } from './dto/refund-request.dto';
import { RefundsService } from './refunds.service';

@Controller()
export class RefundsController {
  constructor(private readonly refunds: RefundsService) {}

  @Roles(Role.CUSTOMER)
  @Post('orders/:id/refund-requests')
  @HttpCode(HttpStatus.CREATED)
  request(
    @Param('id', new ParseUUIDPipe({ version: '4' })) orderId: string,
    @Body() dto: CreateRefundRequestDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.refunds.requestRefund(user.id, orderId, dto);
  }

  @Roles(Role.CUSTOMER)
  @Get('account/refund-requests')
  myRefunds(@CurrentUser() user: AuthenticatedUser) {
    return this.refunds.listForCustomer(user.id);
  }

  @Roles(Role.ADMIN)
  @Get('admin/refund-requests')
  listAdmin(@Query('status') status?: RefundStatus) {
    return this.refunds.listForAdmin(status);
  }

  @Roles(Role.ADMIN)
  @Post('admin/refund-requests/:id/approve')
  @HttpCode(HttpStatus.OK)
  approve(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.refunds.approve(id, user);
  }

  @Roles(Role.ADMIN)
  @Post('admin/refund-requests/:id/reject')
  @HttpCode(HttpStatus.OK)
  reject(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: RejectRefundDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.refunds.reject(id, user, dto.reason);
  }
}
