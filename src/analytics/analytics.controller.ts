import { Controller, DefaultValuePipe, Get, ParseIntPipe, Query } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { AnalyticsService } from './analytics.service';

@Controller('admin/analytics')
@Roles(Role.ADMIN)
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('dashboard')
  dashboard() {
    return this.analytics.dashboard();
  }

  /** SDS §6.5 — 30-day trend by default; 1–365 days accepted. */
  @Get('revenue-series')
  revenue(@Query('days', new DefaultValuePipe(30), ParseIntPipe) days: number) {
    return this.analytics.revenueSeries(Math.min(365, Math.max(1, days)));
  }

  @Get('top-selling')
  topSelling(@Query('limit', new DefaultValuePipe(5), ParseIntPipe) limit: number) {
    return this.analytics.topSelling(Math.min(50, Math.max(1, limit)));
  }
}
