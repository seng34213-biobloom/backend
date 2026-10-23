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

  @Get('revenue-series')
  revenue() {
    return this.analytics.revenueSeries();
  }

  @Get('top-selling')
  topSelling(@Query('limit', new DefaultValuePipe(5), ParseIntPipe) limit: number) {
    return this.analytics.topSelling(Math.min(50, Math.max(1, limit)));
  }
}
