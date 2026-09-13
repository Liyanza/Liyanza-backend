import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Request,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Request as ExpressRequest } from 'express';
import { Role } from '@prisma/client';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AssistantIService } from './assistant-ia.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Roles } from '../auth/decorators/roles.decorator';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { EnvoyerMessageDto } from './dto/envoyer-message.dto';

interface AuthenticatedRequest extends ExpressRequest {
  user: AuthenticatedUser;
}

@ApiTags('assistant-ia')
@ApiBearerAuth()
@Controller()
export class AssistantIController {
  constructor(private readonly assistantService: AssistantIService) {}

  /**
   * POST /conversations
   * Create a new AI conversation.
   */
  @Post('conversations')
  @Roles(Role.ADMIN, Role.MARKETING_MANAGER)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new AI assistant conversation' })
  @ApiResponse({ status: 201, description: 'Conversation created' })
  async createConversation(
    @Body() dto: CreateConversationDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.assistantService.createConversation(dto, req.user);
  }

  /**
   * POST /conversations/:id/messages
   * Send a message, persist user message, call IA, persist IA response.
   */
  @Post('conversations/:id/messages')
  @Roles(Role.ADMIN, Role.MARKETING_MANAGER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send a message and get the AI assistant reply' })
  @ApiResponse({ status: 200, description: 'AI reply persisted and returned' })
  async envoyerMessage(
    @Param('id') conversationId: string,
    @Body() dto: EnvoyerMessageDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.assistantService.envoyerMessage(conversationId, dto, req.user);
  }

  /**
   * GET /conversations/:id
   * Retrieve full conversation history (chronological).
   */
  @Get('conversations/:id')
  @Roles(Role.ADMIN, Role.MARKETING_MANAGER)
  @ApiOperation({ summary: 'Get the full conversation history' })
  @ApiResponse({ status: 200, description: 'Conversation with its messages' })
  async getConversation(
    @Param('id') conversationId: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.assistantService.getConversation(conversationId, req.user);
  }

  /**
   * GET /campagnes/:id/recommandations
   * List recommendations for a campaign, sorted by priority.
   */
  @Get('campagnes/:id/recommandations')
  @Roles(Role.ADMIN, Role.MARKETING_MANAGER)
  @ApiOperation({ summary: 'List AI recommendations for a campaign' })
  @ApiResponse({ status: 200, description: 'Recommendations by priority' })
  async getRecommandations(
    @Param('id') campaignId: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.assistantService.getRecommandations(campaignId, req.user);
  }

  /**
   * POST /campagnes/:id/recommandations/generer
   * Trigger generation of recommendations via IA engine.
   */
  @Post('campagnes/:id/recommandations/generer')
  @Roles(Role.ADMIN, Role.MARKETING_MANAGER)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Trigger generation of new recommendations' })
  @ApiResponse({ status: 201, description: 'Recommendations generated' })
  async genererRecommandations(
    @Param('id') campaignId: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.assistantService.genererRecommandations(campaignId, req.user);
  }
}
