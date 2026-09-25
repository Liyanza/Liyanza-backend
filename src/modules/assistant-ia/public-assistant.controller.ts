import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { streamSse } from '../../common/http/sse.util';
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
   * `@SkipThrottle()` : cette route a ses propres quotas, plus stricts et
   * journaliers, appliqués par `PublicAssistantService` sur l'IP réelle du
   * visiteur ; le limiteur global ferait double emploi.
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

  /** Même question, réponse relayée en Server-Sent Events (voir `askStream`). */
  @Post('ask/stream')
  @Public()
  @SkipThrottle()
  @ApiOperation({
    summary: 'Ask the public showcase assistant, streamed (SSE)',
  })
  @ApiResponse({ status: 200, description: 'text/event-stream' })
  @ApiResponse({ status: 429, description: 'Visitor quota exceeded' })
  async askStream(
    @Body() dto: PublicAskDto,
    @Req() request: Request,
    @Res() res: Response,
  ): Promise<void> {
    const visitorIp = this.publicAssistant.resolveVisitorIp(request);
    await streamSse(res, (emit) =>
      this.publicAssistant.askStream(dto, visitorIp, emit),
    );
  }
}
