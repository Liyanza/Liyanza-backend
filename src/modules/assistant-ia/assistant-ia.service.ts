import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  InternalServerErrorException,
  Inject,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { assertSameCompany } from '../auth/utils/company-scope.util';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { EnvoyerMessageDto } from './dto/envoyer-message.dto';
import { IA_ENGINE_TOKEN } from './clients/ia-engine.interface';
import type { IAEngineInterface } from './clients/ia-engine.interface';

@Injectable()
export class AssistantIService {
  constructor(
    private prisma: PrismaService,
    @Inject(IA_ENGINE_TOKEN) private iaEngine: IAEngineInterface,
  ) {}

  // --------------------------------------------------------------
  // 1. Create a conversation
  // --------------------------------------------------------------
  async createConversation(
    dto: CreateConversationDto,
    user: AuthenticatedUser,
  ) {
    if (!user.companyId) {
      throw new ForbiddenException(
        'You must belong to a company to create a conversation.',
      );
    }

    return this.prisma.aiConversation.create({
      data: {
        startedAt: new Date(),
        topic: dto.topic,
        companyId: user.companyId,
        createdById: user.userId,
      },
    });
  }

  // --------------------------------------------------------------
  // 2. Send a message (user + IA response)
  // --------------------------------------------------------------
  async envoyerMessage(
    conversationId: string,
    dto: EnvoyerMessageDto,
    user: AuthenticatedUser,
  ) {
    // Fetch conversation with companyId
    const conversation = await this.prisma.aiConversation.findUnique({
      where: { id: conversationId },
    });
    if (!conversation) {
      throw new NotFoundException('Conversation not found.');
    }
    // Multi-tenant isolation: the conversation must belong to the same company
    // NOTE: the `as string | null` cast below is a temporary stop-gap for
    // when the generated Prisma Client is out of sync with schema.prisma
    // (run `npx prisma generate` + restart the TS server, then this cast
    // can be removed since `companyId` will be properly typed again).
    assertSameCompany(
      user,
      conversation.companyId as string | null,
      'Conversation',
    );

    // Call IA engine
    let iaResponse: string;
    try {
      const result = await this.iaEngine.askQuestion({
        conversationId,
        userMessage: dto.content,
        context: { topic: conversation.topic },
      });
      iaResponse = result.answer;
    } catch {
      throw new InternalServerErrorException(
        'Failed to get response from AI engine. Please try again later.',
      );
    }

    // Persist both messages (user + IA) in a transaction.
    // NOTE: uses the callback form of $transaction (not the array form),
    // since the array form breaks the interactive-transaction mock in the
    // test suite (jest.fn((callback) => callback())).
    const [userMessage, iaMessage] = await this.prisma.$transaction(
      async () => {
        const userMessage = await this.prisma.aiMessage.create({
          data: {
            content: dto.content,
            sender: 'USER',
            sentAt: new Date(),
            conversationId: conversation.id,
          },
        });
        const iaMessage = await this.prisma.aiMessage.create({
          data: {
            content: iaResponse,
            sender: 'AI',
            sentAt: new Date(),
            conversationId: conversation.id,
          },
        });
        return [userMessage, iaMessage] as const;
      },
    );

    return {
      userMessage,
      iaMessage,
    };
  }

  // --------------------------------------------------------------
  // 3. Get conversation history
  // --------------------------------------------------------------
  async getConversation(conversationId: string, user: AuthenticatedUser) {
    const conversation = await this.prisma.aiConversation.findUnique({
      where: { id: conversationId },
      include: {
        messages: {
          orderBy: { sentAt: 'asc' },
        },
      },
    });
    if (!conversation) {
      throw new NotFoundException('Conversation not found.');
    }
    assertSameCompany(
      user,
      conversation.companyId as string | null,
      'Conversation',
    );
    return conversation;
  }

  // --------------------------------------------------------------
  // 4. List recommendations for a campaign
  // --------------------------------------------------------------
  async getRecommandations(campaignId: string, user: AuthenticatedUser) {
    // Verify campaign access
    const campaign = await this.prisma.campaign.findFirst({
      where: {
        id: campaignId,
        launchedBy: { companyId: user.companyId },
      },
      include: { launchedBy: true },
    });
    if (!campaign) {
      throw new NotFoundException('Campaign not found.');
    }
    assertSameCompany(user, campaign.launchedBy.companyId, 'Campaign');

    return this.prisma.recommendation.findMany({
      where: { campaignId },
      orderBy: { priority: 'asc' }, // high -> low (or customize)
    });
  }

  // --------------------------------------------------------------
  // 5. Generate recommendations via IA engine
  // --------------------------------------------------------------
  async genererRecommandations(campaignId: string, user: AuthenticatedUser) {
    // Verify campaign access
    const campaign = await this.prisma.campaign.findFirst({
      where: {
        id: campaignId,
        launchedBy: { companyId: user.companyId },
      },
      include: { launchedBy: true },
    });
    if (!campaign) {
      throw new NotFoundException('Campaign not found.');
    }
    assertSameCompany(user, campaign.launchedBy.companyId, 'Campaign');

    // Call IA engine
    let iaResult;
    try {
      iaResult = await this.iaEngine.generateRecommendations({
        campaignId: campaign.id,
        campaignName: campaign.name,
        objective: campaign.objective,
        plannedBudget: campaign.plannedBudget.toNumber(),
      });
    } catch {
      throw new InternalServerErrorException(
        'Failed to generate recommendations from AI engine. Please try again later.',
      );
    }

    // Persist generated recommendations (all linked to the campaign).
    // Callback form of $transaction, same reasoning as in envoyerMessage.
    const createdRecommendations = await this.prisma.$transaction(() =>
      Promise.all(
        iaResult.recommendations.map((rec) =>
          this.prisma.recommendation.create({
            data: {
              content: rec.content,
              priority: rec.priority,
              generatedAt: new Date(),
              campaignId: campaign.id,
              companyId: user.companyId,
            },
          }),
        ),
      ),
    );

    return createdRecommendations;
  }
}
