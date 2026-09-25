import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  InternalServerErrorException,
  BadRequestException,
  Inject,
  Logger,
} from '@nestjs/common';
import { AiConversation } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { assertSameCompany } from '../auth/utils/company-scope.util';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { EnvoyerMessageDto } from './dto/envoyer-message.dto';
import { UpdateConversationDto } from './dto/update-conversation.dto';
import { MessageFeedbackDto } from './dto/message-feedback.dto';
import { RegenererReponseDto } from './dto/regenerer-reponse.dto';
import { IA_ENGINE_TOKEN } from './clients/ia-engine.interface';
import type { SseEmit } from '../../common/http/sse.util';
import type {
  AskQuestionContext,
  CampaignContext,
  IAEngineInterface,
} from './clients/ia-engine.interface';

/** Nombre maximal de messages renvoyés par `getConversation`. */
const MAX_CONVERSATION_MESSAGES = 200;

/** Nombre maximal de conversations listées dans l'historique du Copilot. */
const MAX_LISTED_CONVERSATIONS = 100;

/**
 * Historique transmis au moteur IA pour qu'il suive le fil de la
 * conversation : les derniers échanges seulement, chacun tronqué — un
 * message peut faire 5 000 caractères (`EnvoyerMessageDto`), les renvoyer
 * tous gonflerait chaque appel LLM (latence, quota Gemini).
 */
const IA_CONTEXT_MESSAGES = 10;
const IA_CONTEXT_MESSAGE_MAX_LENGTH = 1_500;

/** Indicateurs (`Statistic`) transmis au plus pour une campagne. */
const IA_CONTEXT_CAMPAIGN_STATISTICS = 50;

/**
 * Conversations de l'assistant IA (Copilot du dashboard).
 *
 * Une conversation est PERSONNELLE : seul son auteur peut la lire, la
 * poursuivre, la renommer ou la supprimer (`loadOwnConversation`), en plus de
 * l'isolation multi-tenant habituelle. Un collègue de la même entreprise
 * reçoit un 404, comme pour une ressource d'une autre entreprise.
 */
@Injectable()
export class AssistantIService {
  private readonly logger = new Logger(AssistantIService.name);

  constructor(
    private prisma: PrismaService,
    @Inject(IA_ENGINE_TOKEN) private iaEngine: IAEngineInterface,
  ) {}

  // --------------------------------------------------------------
  // 1. Conversations : création, liste, lecture, renommage, suppression
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

    const now = new Date();
    return this.prisma.aiConversation.create({
      data: {
        startedAt: now,
        lastMessageAt: now,
        topic: dto.topic,
        companyId: user.companyId,
        createdById: user.userId,
      },
    });
  }

  /** Historique du Copilot : les conversations de l'utilisateur, les plus récentes d'abord. */
  async listConversations(user: AuthenticatedUser) {
    if (!user.companyId) {
      return [];
    }
    return this.prisma.aiConversation.findMany({
      where: { createdById: user.userId, companyId: user.companyId },
      orderBy: { lastMessageAt: 'desc' },
      take: MAX_LISTED_CONVERSATIONS,
      select: { id: true, topic: true, startedAt: true, lastMessageAt: true },
    });
  }

  async getConversation(conversationId: string, user: AuthenticatedUser) {
    await this.loadOwnConversation(conversationId, user);

    // CORRECTIF AUDIT (majeur — DoS) : `messages` était chargé sans aucune
    // borne. On borne aux 200 derniers messages, renvoyés dans l'ordre
    // chronologique attendu par le client.
    const conversation = await this.prisma.aiConversation.findUnique({
      where: { id: conversationId },
      include: {
        messages: {
          orderBy: { sentAt: 'desc' },
          take: MAX_CONVERSATION_MESSAGES,
        },
      },
    });
    if (!conversation) {
      throw new NotFoundException('Conversation not found.');
    }

    // `take` impose un tri décroissant pour récupérer les plus récents ;
    // le client attend l'ordre chronologique.
    return {
      ...conversation,
      messages: [...conversation.messages].reverse(),
    };
  }

  async renameConversation(
    conversationId: string,
    dto: UpdateConversationDto,
    user: AuthenticatedUser,
  ) {
    await this.loadOwnConversation(conversationId, user);
    return this.prisma.aiConversation.update({
      where: { id: conversationId },
      data: { topic: dto.topic },
      select: { id: true, topic: true, startedAt: true, lastMessageAt: true },
    });
  }

  async deleteConversation(conversationId: string, user: AuthenticatedUser) {
    await this.loadOwnConversation(conversationId, user);
    // Les messages d'abord (FK RESTRICT). Une `Recommendation` issue d'un
    // message garde son contenu : sa référence passe à NULL (FK SET NULL).
    await this.prisma.$transaction([
      this.prisma.aiMessage.deleteMany({ where: { conversationId } }),
      this.prisma.aiConversation.delete({ where: { id: conversationId } }),
    ]);
  }

  // --------------------------------------------------------------
  // 2. Messages : envoi, régénération, avis
  // --------------------------------------------------------------
  async envoyerMessage(
    conversationId: string,
    dto: EnvoyerMessageDto,
    user: AuthenticatedUser,
  ) {
    const conversation = await this.loadOwnConversation(conversationId, user);

    const context = await this.buildIAContext(
      conversation,
      user.companyId,
      dto.campaignId,
    );
    const iaResponse = await this.askIA(conversation.id, dto.content, context);
    return this.persistExchange(conversation.id, dto.content, iaResponse);
  }

  /**
   * Même échange qu'`envoyerMessage`, mais la réponse de l'IA est relayée
   * morceau par morceau (`{ type: 'delta', text }`) au fil de sa génération.
   * Les deux messages ne sont enregistrés qu'une fois la réponse complète,
   * puis renvoyés dans l'événement final `{ type: 'done', userMessage,
   * iaMessage }`. Une réponse interrompue n'est jamais enregistrée.
   */
  async envoyerMessageStream(
    conversationId: string,
    dto: EnvoyerMessageDto,
    user: AuthenticatedUser,
    emit: SseEmit,
  ): Promise<void> {
    const conversation = await this.loadOwnConversation(conversationId, user);
    const context = await this.buildIAContext(
      conversation,
      user.companyId,
      dto.campaignId,
    );

    let answer = '';
    try {
      for await (const text of this.iaEngine.streamQuestion({
        conversationId: conversation.id,
        userMessage: dto.content,
        context,
      })) {
        answer += text;
        emit({ type: 'delta', text });
      }
    } catch (error) {
      this.logger.error(
        `IA stream failed for conversation ${conversation.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw new InternalServerErrorException(
        'Failed to get response from AI engine. Please try again later.',
      );
    }
    if (!answer) {
      throw new InternalServerErrorException(
        'Failed to get response from AI engine. Please try again later.',
      );
    }

    const { userMessage, iaMessage } = await this.persistExchange(
      conversation.id,
      dto.content,
      answer,
    );
    emit({ type: 'done', userMessage, iaMessage });
  }

  /**
   * Enregistre la question et la réponse, atomiquement, et avance
   * `lastMessageAt` (tri de l'historique).
   *
   * CORRECTIF AUDIT (majeur) : le callback DOIT utiliser le client
   * transactionnel `tx` reçu en paramètre, jamais `this.prisma`, sinon
   * aucune atomicité réelle.
   */
  private async persistExchange(
    conversationId: string,
    question: string,
    answer: string,
  ) {
    const [userMessage, iaMessage] = await this.prisma.$transaction(
      async (tx) => {
        const userMessage = await tx.aiMessage.create({
          data: {
            content: question,
            sender: 'USER',
            sentAt: new Date(),
            conversationId,
          },
        });
        const iaMessage = await tx.aiMessage.create({
          data: {
            content: answer,
            sender: 'AI',
            sentAt: new Date(),
            conversationId,
          },
        });
        await tx.aiConversation.update({
          where: { id: conversationId },
          data: { lastMessageAt: iaMessage.sentAt },
        });
        return [userMessage, iaMessage] as const;
      },
    );

    return {
      userMessage,
      iaMessage,
    };
  }

  /**
   * Remplace la DERNIÈRE réponse de l'IA par une nouvelle réponse à la même
   * question (bouton « Régénérer »). Seule la dernière réponse est
   * régénérable : en régénérer une plus ancienne rendrait incohérente la
   * suite de la conversation.
   */
  async regenererDerniereReponse(
    conversationId: string,
    dto: RegenererReponseDto,
    user: AuthenticatedUser,
  ) {
    const conversation = await this.loadOwnConversation(conversationId, user);

    const [lastAnswer, lastQuestion] = await this.prisma.aiMessage.findMany({
      where: { conversationId },
      orderBy: { sentAt: 'desc' },
      take: 2,
    });
    if (lastAnswer?.sender !== 'AI' || lastQuestion?.sender !== 'USER') {
      throw new BadRequestException('Nothing to regenerate.');
    }

    const context = await this.buildIAContext(
      conversation,
      user.companyId,
      dto.campaignId,
      lastQuestion.sentAt,
    );
    const iaResponse = await this.askIA(
      conversation.id,
      lastQuestion.content,
      context,
    );

    return this.prisma.$transaction(async (tx) => {
      const iaMessage = await tx.aiMessage.update({
        where: { id: lastAnswer.id },
        data: { content: iaResponse, sentAt: new Date(), feedback: null },
      });
      await tx.aiConversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: iaMessage.sentAt },
      });
      return iaMessage;
    });
  }

  async setMessageFeedback(
    conversationId: string,
    messageId: string,
    dto: MessageFeedbackDto,
    user: AuthenticatedUser,
  ) {
    await this.loadOwnConversation(conversationId, user);
    const message = await this.prisma.aiMessage.findFirst({
      where: { id: messageId, conversationId, sender: 'AI' },
      select: { id: true },
    });
    if (!message) {
      throw new NotFoundException('Message not found.');
    }
    return this.prisma.aiMessage.update({
      where: { id: message.id },
      data: { feedback: dto.value ?? null },
      select: { id: true, feedback: true },
    });
  }

  // --------------------------------------------------------------
  // 3. Helpers
  // --------------------------------------------------------------

  /**
   * Charge une conversation en vérifiant l'entreprise ET l'auteur. Dans les
   * deux cas d'échec : 404, pour ne pas révéler qu'elle existe.
   */
  private async loadOwnConversation(
    conversationId: string,
    user: AuthenticatedUser,
  ): Promise<AiConversation> {
    const conversation = await this.prisma.aiConversation.findUnique({
      where: { id: conversationId },
    });
    if (!conversation) {
      throw new NotFoundException('Conversation not found.');
    }
    assertSameCompany(user, conversation.companyId, 'Conversation');
    if (conversation.createdById !== user.userId) {
      throw new NotFoundException('Conversation not found.');
    }
    return conversation;
  }

  private async askIA(
    conversationId: string,
    userMessage: string,
    context: AskQuestionContext,
  ): Promise<string> {
    try {
      const result = await this.iaEngine.askQuestion({
        conversationId,
        userMessage,
        context,
      });
      return result.answer;
    } catch (error) {
      this.logger.error(
        `IA engine failed for conversation ${conversationId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw new InternalServerErrorException(
        'Failed to get response from AI engine. Please try again later.',
      );
    }
  }

  /**
   * Profil de l'entreprise, derniers échanges et, depuis le Copilot, la
   * campagne affichée. Toujours limités à l'entreprise de l'utilisateur :
   * `loadOwnConversation` a été vérifié par l'appelant.
   *
   * `before` : ne reprendre que les messages antérieurs (régénération — la
   * question régénérée ne doit pas figurer aussi dans l'historique).
   */
  private async buildIAContext(
    conversation: AiConversation,
    companyId: string | null,
    campaignId?: string,
    before?: Date,
  ): Promise<AskQuestionContext> {
    const [company, lastMessages, campaign] = await Promise.all([
      companyId
        ? this.prisma.company.findUnique({
            where: { id: companyId },
            select: { name: true, businessSector: true, address: true },
          })
        : null,
      this.prisma.aiMessage.findMany({
        where: {
          conversationId: conversation.id,
          ...(before && { sentAt: { lt: before } }),
        },
        orderBy: { sentAt: 'desc' },
        take: IA_CONTEXT_MESSAGES,
        select: { sender: true, content: true },
      }),
      campaignId ? this.buildCampaignContext(campaignId, companyId) : null,
    ]);

    const recentMessages = lastMessages
      .reverse()
      .filter(
        (m): m is { sender: 'USER' | 'AI'; content: string } =>
          m.sender === 'USER' || m.sender === 'AI',
      )
      .map((m) => ({
        sender: m.sender,
        content: m.content.slice(0, IA_CONTEXT_MESSAGE_MAX_LENGTH),
      }));

    return {
      topic: conversation.topic,
      ...(company && { companyProfile: company }),
      ...(campaign && { campaign }),
      ...(recentMessages.length > 0 && { recentMessages }),
    };
  }

  private async buildCampaignContext(
    campaignId: string,
    companyId: string | null,
  ): Promise<CampaignContext> {
    const campaign = companyId
      ? await this.prisma.campaign.findFirst({
          where: { id: campaignId, launchedBy: { companyId } },
          select: {
            name: true,
            objective: true,
            status: true,
            plannedBudget: true,
            startDate: true,
            endDate: true,
            channels: { select: { radio: true, poster: true, flyer: true } },
            digitalDetails: {
              select: { channels: { select: { platform: true } } },
            },
            statistics: {
              orderBy: { computedAt: 'desc' },
              take: IA_CONTEXT_CAMPAIGN_STATISTICS,
              select: { indicator: true, value: true },
            },
          },
        })
      : null;
    if (!campaign) {
      throw new NotFoundException('Campaign not found.');
    }

    const channels = new Set<string>();
    for (const channel of campaign.channels) {
      if (channel.radio) channels.add('Radio');
      if (channel.poster) channels.add('Affichage');
      if (channel.flyer) channels.add('Flyers');
    }
    for (const channel of campaign.digitalDetails?.channels ?? []) {
      channels.add(channel.platform);
    }

    // Statistiques triées de la plus récente à la plus ancienne : on garde
    // la dernière valeur connue de chaque indicateur.
    const results: Record<string, number> = {};
    for (const stat of campaign.statistics) {
      if (!(stat.indicator in results)) {
        results[stat.indicator] = stat.value;
      }
    }

    const toDay = (date: Date) => date.toISOString().slice(0, 10);
    return {
      name: campaign.name,
      objective: campaign.objective,
      status: campaign.status,
      plannedBudget: campaign.plannedBudget.toNumber(),
      startDate: toDay(campaign.startDate),
      endDate: toDay(campaign.endDate),
      channels: [...channels],
      results,
    };
  }

  // --------------------------------------------------------------
  // 4. Recommandations : liste pour une campagne
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
  // 5. Recommandations : génération via le moteur IA
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

    // Persist generated recommendations (all linked to the campaign)
    // atomically — même correctif que dans `envoyerMessage` : le callback
    // utilise le client transactionnel `tx`, jamais `this.prisma`.
    const createdRecommendations = await this.prisma.$transaction((tx) =>
      Promise.all(
        iaResult.recommendations.map((rec) =>
          tx.recommendation.create({
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
