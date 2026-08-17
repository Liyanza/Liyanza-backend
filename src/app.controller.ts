import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  /**
   * Endpoint de santé stub pour le Docker Compose.
   * Sera remplacé par le HealthModule complet en Phase 0 (BACK-006).
   */
  @Get('health')
  getHealth(): Record<string, string> {
    return { status: 'ok' };
  }
}
