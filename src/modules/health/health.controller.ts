import { Controller, Get } from '@nestjs/common';
import {
  HealthCheckService,
  HealthCheck,
  HealthIndicatorResult,
} from '@nestjs/terminus';

@Controller('health')
export class HealthController {
  constructor(private health: HealthCheckService) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([
      // Placeholder pour la base de données (sera remplacé en Phase 1)
      (): Promise<HealthIndicatorResult> =>
        Promise.resolve({ database: { status: 'up' } }),
      // Placeholder pour Redis (sera remplacé en Phase 1)
      (): Promise<HealthIndicatorResult> =>
        Promise.resolve({ redis: { status: 'up' } }),
    ]);
  }
}
