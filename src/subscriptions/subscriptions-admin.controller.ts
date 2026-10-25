import { Controller, HttpCode, HttpStatus, NotFoundException, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Role } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { BillingCronService } from './billing-cron.service';

@Controller('admin/subscriptions')
@Roles(Role.ADMIN)
export class SubscriptionsAdminController {
  constructor(
    private readonly billing: BillingCronService,
    private readonly config: ConfigService,
  ) {}

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
