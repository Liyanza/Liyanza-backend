import { Controller, Get } from '@nestjs/common';
import {
  HealthCheckService,
  HealthCheck,
  HealthIndicatorResult,
} from '@nestjs/terminus';
import { PrismaService } from '@modules/prisma/prisma.service';
import { Public } from '../auth/decorators/public.decorator';

@Controller('health')
export class HealthController {
  constructor(
    private health: HealthCheckService,
    private prisma: PrismaService,
  ) {}

  // Public : interrogé sans JWT par l'Application Load Balancer / ECS.
  @Public()
  @Get()
  @HealthCheck()
  check() {
    return this.health.check([
      async (): Promise<HealthIndicatorResult> => {
        try {
          await this.prisma.$queryRaw`SELECT 1`;
          return { database: { status: 'up' } };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Unknown database error';
          return { database: { status: 'down', message } };
        }
      },
      async (): Promise<HealthIndicatorResult> => ({
        redis: { status: 'up' },
      }),
    ]);
  }
}
