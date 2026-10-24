import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';

export interface HealthStatus {
  status: 'ok';
  timestamp: string;
  commit: string | null;
}

// Liveness probe for load balancer and deployment health checks. `commit` is
// the deployed commit SHA that Render sets, so the deploy job can tell the new
// version apart from the previous one; it is null outside Render.
@Controller('health')
export class HealthController {
  @Public()
  @Get()
  check(): HealthStatus {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      commit: process.env.RENDER_GIT_COMMIT || null,
    };
  }
}
