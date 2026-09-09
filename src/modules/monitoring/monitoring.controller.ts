import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { MonitoringService } from './monitoring.service';
import { RecordDetectionDto } from './dto/record-detection.dto';
import { InternalTokenGuard } from './guards/internal-token.guard';

/**
 * Webhook interne d'ingestion des détections de diffusion radio (BACK-304).
 * `@Public()` (pas de JWT utilisateur — le futur `Liyanza-ia` n'a pas de
 * compte applicatif) mais protégé par `InternalTokenGuard` (secret partagé)
 * — voir `.claude/skills/liyanza-ia-boundary/SKILL.md`.
 */
@ApiTags('monitoring')
@Controller('internal/monitoring')
export class MonitoringController {
  constructor(private readonly monitoringService: MonitoringService) {}

  @Public()
  @UseGuards(InternalTokenGuard)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post('detections')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Ingest an already-performed radio broadcast detection (internal webhook, not the detection logic itself)',
  })
  @ApiResponse({ status: 200, description: 'Detection recorded (idempotent)' })
  async recordDetection(@Body() dto: RecordDetectionDto) {
    return this.monitoringService.recordDetection(dto);
  }
}
