import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  InternalServerErrorException,
  Inject,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { assertSameCompany } from '../auth/utils/company-scope.util';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { EnvoyerMessageDto } from './dto/envoyer-message.dto';
import { IA_ENGINE_TOKEN } from './clients/ia-engine.interface';
import type {
  AskQuestionContext,
  IAEngineInterface,
} from './clients/ia-engine.interface';

/** Nombre maximal de messages renvoyés par `getConversation`. */
const MAX_CONVERSATION_MESSAGES = 200;

/**
 * Historique transmis au moteur IA pour qu'il suive le fil de la
 * conversation : les derniers échanges seulement, chacun tronqué — un
 * message peut faire 5 000 caractères (`EnvoyerMessageDto`), les renvoyer
 * tous gonflerait chaque appel LLM (latence, quota Gemini).
 */
const IA_CONTEXT_MESSAGES = 10;
const IA_CONTEXT_MESSAGE_MAX_LENGTH = 1_500;

@Injectable()
export class AssistantIService {
  private readonly logger = new Logger(AssistantIService.name);

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
    assertSameCompany(user, conversation.companyId, 'Conversation');

    const context = await this.buildIAContext(
      conversation.id,
      conversation.topic,
      user.companyId,
    );

    // Call IA engine
    let iaResponse: string;
    try {
      const result = await this.iaEngine.askQuestion({
        conversationId,
        userMessage: dto.content,
        context,
      });
      iaResponse = result.answer;
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

    // Persist both messages (user + IA) atomically.
    //
    // CORRECTIF AUDIT (majeur) : la version précédente appelait
    // `this.prisma.$transaction(async () => { this.prisma.aiMessage.create(...) })`
    // en ignorant le client transactionnel `tx` fourni par Prisma, et en
    // réutilisant `this.prisma` (le client racine, hors transaction) à
    // l'intérieur du callback. Résultat : aucune atomicité réelle — si la
    // seconde écriture échouait, la première restait committée sans rollback.
    // Le callback DOIT utiliser le client `tx` reçu en paramètre.
    const [userMessage, iaMessage] = await this.prisma.$transaction(
      async (tx) => {
        const userMessage = await tx.aiMessage.create({
          data: {
            content: dto.content,
            sender: 'USER',
            sentAt: new Date(),
            conversationId: conversation.id,
          },
        });
        const iaMessage = await tx.aiMessage.create({
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

  /**
   * Profil de l'entreprise + derniers échanges, lus AVANT d'enregistrer le
   * nouveau message (il est déjà transmis dans `userMessage`). Toujours
   * limités à l'entreprise de l'utilisateur : `assertSameCompany` a été
   * vérifié par l'appelant.
   */
  private async buildIAContext(
    conversationId: string,
    topic: string,
    companyId: string | null,
  ): Promise<AskQuestionContext> {
    const [company, lastMessages] = await Promise.all([
      companyId
        ? this.prisma.company.findUnique({
            where: { id: companyId },
            select: { name: true, businessSector: true, address: true },
          })
        : null,
      this.prisma.aiMessage.findMany({
        where: { conversationId },
        orderBy: { sentAt: 'desc' },
        take: IA_CONTEXT_MESSAGES,
        select: { sender: true, content: true },
      }),
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
      topic,
      ...(company && { companyProfile: company }),
      ...(recentMessages.length > 0 && { recentMessages }),
    };
  }

  // --------------------------------------------------------------
  // 3. Get conversation history
  // --------------------------------------------------------------
  async getConversation(conversationId: string, user: AuthenticatedUser) {
    // CORRECTIF AUDIT (majeur — DoS) : `messages` était chargé sans aucune
    // borne. Une conversation longue (chaque échange produisant deux
    // `AiMessage` de 5 000 caractères — cf. `EnvoyerMessageDto`) était
    // intégralement matérialisée en mémoire puis sérialisée en JSON à chaque
    // consultation. Quelques milliers de messages suffisent à saturer le heap
    // d'une tâche Fargate. On borne aux 200 derniers messages, renvoyés dans
    // l'ordre chronologique attendu par le client.
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
    assertSameCompany(user, conversation.companyId, 'Conversation');

    // `take` impose un tri décroissant pour récupérer les plus récents ;
    // le client attend l'ordre chronologique.
    return {
      ...conversation,
      messages: [...conversation.messages].reverse(),
    };
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
