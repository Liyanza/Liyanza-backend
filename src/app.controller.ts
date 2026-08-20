import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { Public } from './modules/auth/decorators/public.decorator';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Public()
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  /**
   * Endpoint de santé stub pour le Docker Compose.
   * Sera remplacé par le HealthModule complet en Phase 0 (BACK-006).
   * @Public() : requis, interrogé par les probes infra sans JWT.
   */
  @Public()
  @Get('health')
  getHealth(): Record<string, string> {
    return { status: 'ok' };
  }
}
