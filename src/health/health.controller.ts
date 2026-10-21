import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';

export interface HealthStatus {
  status: 'ok';
  timestamp: string;
}

// Liveness probe for load balancer and deployment health checks.
@Controller('health')
export class HealthController {
  @Public()
  @Get()
  check(): HealthStatus {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
}
