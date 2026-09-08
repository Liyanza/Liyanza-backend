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

/** Nombre maximal de messages renvoyés par `getConversation`. */
const MAX_CONVERSATION_MESSAGES = 200;

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
    assertSameCompany(user, conversation.companyId, 'Conversation');

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
