import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { FulfilmentService } from './fulfilment.service';

@Controller('admin/fulfilment')
@Roles(Role.ADMIN, Role.FULFILMENT_STAFF)
export class FulfilmentController {
  constructor(private readonly fulfilment: FulfilmentService) {}

  @Get('open')
  open() {
    return this.fulfilment.listOpen();
  }

  @Get('shipped')
  shipped() {
    return this.fulfilment.listShipped();
  }

  @Post('orders/:id/packing')
  @HttpCode(HttpStatus.OK)
  packing(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.fulfilment.markPacking(id, user);
  }

  @Post('orders/:id/shipped')
  @HttpCode(HttpStatus.OK)
  shippedFlip(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.fulfilment.markShipped(id, user);
  }

  @Post('orders/:id/delivered')
  @HttpCode(HttpStatus.OK)
  delivered(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.fulfilment.markDelivered(id, user);
  }
}
