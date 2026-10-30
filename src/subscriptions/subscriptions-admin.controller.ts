import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { BillingCronService } from './billing-cron.service';
import { AdminSubscriptionsQueryDto } from './dto/admin-subscriptions-query.dto';
import { SubscriptionsAdminService } from './subscriptions-admin.service';

@Controller('admin/subscriptions')
@Roles(Role.ADMIN)
export class SubscriptionsAdminController {
  constructor(
    private readonly subscriptions: SubscriptionsAdminService,
    private readonly billing: BillingCronService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  list(@Query() query: AdminSubscriptionsQueryDto) {
    return this.subscriptions.list(query);
  }

  @Patch(':id/pause')
  pause(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.subscriptions.change(id, 'pause', actor);
  }

  @Patch(':id/resume')
  resume(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.subscriptions.change(id, 'resume', actor);
  }

  @Patch(':id/cancel')
  cancel(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.subscriptions.change(id, 'cancel', actor);
  }

  /**
   * Runs one billing pass now, the same code path as the 06:00 UTC job, and
   * returns its counts and duration for the k6 load test. Not available in
   * production builds, staging included.
   */
  @Post('billing/run')
  @HttpCode(HttpStatus.OK)
  async runBilling() {
    if (this.config.get<string>('NODE_ENV') === 'production') throw new NotFoundException();
    const started = Date.now();
    const result = await this.billing.runBilling();
    return { ...result, durationMs: Date.now() - started };
  }
}
