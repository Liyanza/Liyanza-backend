import { Controller, Get } from '@nestjs/common';
import {
  HealthCheckService,
  HealthCheck,
  HealthIndicatorResult,
} from '@nestjs/terminus';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '@modules/prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { Public } from '../auth/decorators/public.decorator';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private health: HealthCheckService,
    private prisma: PrismaService,
    private redis: RedisService,
  ) {}

  // Public : interrogé sans JWT par le health check Render.
  @Public()
  @Get()
  @HealthCheck()
  @ApiOperation({ summary: 'Liveness/readiness check (database + Redis)' })
  @ApiResponse({ status: 200, description: 'All dependencies are up' })
  @ApiResponse({ status: 503, description: 'A dependency is down' })
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
      async (): Promise<HealthIndicatorResult> => {
        try {
          await this.redis.ping();
          return { redis: { status: 'up' } };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Unknown Redis error';
          return { redis: { status: 'down', message } };
        }
      },
    ]);
  }
}
