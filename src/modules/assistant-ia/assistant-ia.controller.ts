import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
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
import { UpdateConversationDto } from './dto/update-conversation.dto';
import { MessageFeedbackDto } from './dto/message-feedback.dto';
import { RegenererReponseDto } from './dto/regenerer-reponse.dto';

interface AuthenticatedRequest extends ExpressRequest {
  user: AuthenticatedUser;
}

/**
 * Rôles ayant accès au Copilot (assistant du dashboard) : tous les membres
 * d'une entreprise, SAUF `PROVIDER` — un prestataire externe (afficheur,
 * radio…) ne doit pas pouvoir interroger les données marketing du client.
 */
const COPILOT_ROLES = [
  Role.ADMIN,
  Role.MARKETING_MANAGER,
  Role.COMMUNITY_MANAGER,
] as const;

@ApiTags('assistant-ia')
@ApiBearerAuth()
@Controller()
export class AssistantIController {
  constructor(private readonly assistantService: AssistantIService) {}

  @Post('conversations')
  @Roles(...COPILOT_ROLES)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new AI assistant conversation' })
  @ApiResponse({ status: 201, description: 'Conversation created' })
  async createConversation(
    @Body() dto: CreateConversationDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.assistantService.createConversation(dto, req.user);
  }

  @Get('conversations')
  @Roles(...COPILOT_ROLES)
  @ApiOperation({
    summary: "List the current user's conversations, most recent first",
  })
  @ApiResponse({ status: 200, description: 'Conversation list (100 max)' })
  async listConversations(@Request() req: AuthenticatedRequest) {
    return this.assistantService.listConversations(req.user);
  }

  @Get('conversations/:id')
  @Roles(...COPILOT_ROLES)
  @ApiOperation({ summary: 'Get the full conversation history' })
  @ApiResponse({ status: 200, description: 'Conversation with its messages' })
  async getConversation(
    @Param('id') conversationId: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.assistantService.getConversation(conversationId, req.user);
  }

  @Patch('conversations/:id')
  @Roles(...COPILOT_ROLES)
  @ApiOperation({ summary: 'Rename a conversation' })
  @ApiResponse({ status: 200, description: 'Conversation renamed' })
  async renameConversation(
    @Param('id') conversationId: string,
    @Body() dto: UpdateConversationDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.assistantService.renameConversation(
      conversationId,
      dto,
      req.user,
    );
  }

  @Delete('conversations/:id')
  @Roles(...COPILOT_ROLES)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a conversation and its messages' })
  @ApiResponse({ status: 204, description: 'Conversation deleted' })
  async deleteConversation(
    @Param('id') conversationId: string,
    @Request() req: AuthenticatedRequest,
  ) {
    await this.assistantService.deleteConversation(conversationId, req.user);
  }

  /**
   * Persist the user message, call the IA (with the displayed campaign as
   * context when `campaignId` is given), persist and return the IA reply.
   */
  @Post('conversations/:id/messages')
  @Roles(...COPILOT_ROLES)
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

  @Post('conversations/:id/regenerate')
  @Roles(...COPILOT_ROLES)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Replace the last AI reply with a new one' })
  @ApiResponse({ status: 200, description: 'Regenerated AI message' })
  async regenererDerniereReponse(
    @Param('id') conversationId: string,
    @Body() dto: RegenererReponseDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.assistantService.regenererDerniereReponse(
      conversationId,
      dto,
      req.user,
    );
  }

  @Patch('conversations/:id/messages/:messageId/feedback')
  @Roles(...COPILOT_ROLES)
  @ApiOperation({ summary: 'Rate an AI reply (UP / DOWN / null)' })
  @ApiResponse({ status: 200, description: 'Feedback saved' })
  async setMessageFeedback(
    @Param('id') conversationId: string,
    @Param('messageId') messageId: string,
    @Body() dto: MessageFeedbackDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.assistantService.setMessageFeedback(
      conversationId,
      messageId,
      dto,
      req.user,
    );
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
