import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { PublicAskDto } from './dto/public-ask.dto';
import { PublicAssistantService } from './public-assistant.service';

@ApiTags('assistant-ia')
@Controller('public/assistant')
export class PublicAssistantController {
  constructor(private readonly publicAssistant: PublicAssistantService) {}

  /**
   * Assistant vitrine du site public, sans authentification.
   *
   * `@SkipThrottle()` : le limiteur global compte par `req.ip`, qui vaut
   * l'IP de Vercel pour toutes les requêtes relayées par le site — il
   * bloquerait tous les visiteurs ensemble. Les quotas sont appliqués par
   * `PublicAssistantService`, sur l'IP réelle du visiteur.
   */
  @Post('ask')
  @Public()
  @SkipThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ask the public showcase assistant (anonymous)' })
  @ApiResponse({ status: 200, description: '{ answer }' })
  @ApiResponse({ status: 429, description: 'Visitor quota exceeded' })
  @ApiResponse({ status: 503, description: 'IA down or daily limit reached' })
  async ask(@Body() dto: PublicAskDto, @Req() request: Request) {
    return this.publicAssistant.ask(
      dto,
      this.publicAssistant.resolveVisitorIp(request),
    );
  }
}
