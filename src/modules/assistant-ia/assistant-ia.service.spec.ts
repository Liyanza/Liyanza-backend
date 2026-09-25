import { Test, TestingModule } from '@nestjs/testing';
import { AssistantIService } from './assistant-ia.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  IA_ENGINE_TOKEN,
  IAEngineInterface,
} from './clients/ia-engine.interface';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Role } from '@prisma/client';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';

// Minimal typed shape of the PrismaService surface this test touches.
// Keeping this explicit (rather than `any`) is what silences
// no-unsafe-call / no-unsafe-assignment / no-unsafe-return below.
type MockedPrisma = {
  aiConversation: {
    create: jest.Mock;
    findUnique: jest.Mock;
    findMany: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
  aiMessage: {
    create: jest.Mock;
    findMany: jest.Mock;
    findFirst: jest.Mock;
    update: jest.Mock;
    deleteMany: jest.Mock;
  };
  company: {
    findUnique: jest.Mock;
  };
  campaign: {
    findFirst: jest.Mock;
  };
  recommendation: {
    findMany: jest.Mock;
    create: jest.Mock;
  };
  $transaction: jest.Mock;
};

// Le client transactionnel `tx` passé au callback de `$transaction` doit
// être un client DISTINCT de `this.prisma` (c'est le comportement réel de
// Prisma). Utiliser le même mock que `prisma.aiMessage.create` aurait
// masqué le bug historique où le service ignorait `tx` et retombait sur
// `this.prisma` — voir le test de régression dédié plus bas.
const buildTxClient = () => ({
  aiMessage: { create: jest.fn(), update: jest.fn() },
  aiConversation: { update: jest.fn() },
  recommendation: { create: jest.fn() },
});

describe('AssistantIService', () => {
  let service: AssistantIService;
  let prisma: MockedPrisma;
  let txClient: ReturnType<typeof buildTxClient>;
  let iaEngine: jest.Mocked<IAEngineInterface>;

  const mockUser: AuthenticatedUser = {
    userId: 'user-1',
    email: 'test@test.com',
    role: Role.ADMIN,
    companyId: 'company-1',
  };

  /** Conversation appartenant à `mockUser` (même entreprise, même auteur). */
  const ownConversation = (overrides: Record<string, unknown> = {}) => ({
    id: 'conv-1',
    topic: 'test',
    companyId: 'company-1',
    createdById: 'user-1',
    ...overrides,
  });

  beforeEach(async () => {
    txClient = buildTxClient();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AssistantIService,
        {
          provide: PrismaService,
          useValue: {
            aiConversation: {
              create: jest.fn(),
              findUnique: jest.fn(),
              findMany: jest.fn(),
              update: jest.fn(),
              delete: jest.fn(),
            },
            aiMessage: {
              // Volontairement PAS de mock ici : si le service régresse et
              // se remet à appeler `this.prisma.aiMessage.create` au lieu de
              // `tx.aiMessage.create`, cet appel renverra `undefined` et les
              // assertions sur `txClient.aiMessage.create` échoueront.
              create: undefined as unknown as jest.Mock,
              findMany: jest.fn(),
              findFirst: jest.fn(),
              update: jest.fn(),
              deleteMany: jest.fn(),
            },
            company: {
              findUnique: jest.fn(),
            },
            campaign: {
              findFirst: jest.fn(),
            },
            recommendation: {
              findMany: jest.fn(),
              create: undefined as unknown as jest.Mock,
            },
            // Callback-style transaction mock, fidèle au comportement réel
            // de Prisma : le callback reçoit un client transactionnel `tx`
            // DISTINCT de `this.prisma`. La forme « tableau » (suppression)
            // résout simplement les opérations fournies.
            $transaction: jest.fn(
              (arg: ((tx: typeof txClient) => unknown) | unknown[]) =>
                Array.isArray(arg) ? Promise.all(arg) : arg(txClient),
            ),
          },
        },
        {
          provide: IA_ENGINE_TOKEN,
          useValue: {
            askQuestion: jest.fn(),
            askPublicQuestion: jest.fn(),
            generateRecommendations: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<AssistantIService>(AssistantIService);
    prisma = module.get(PrismaService);
    iaEngine = module.get(IA_ENGINE_TOKEN);

    // Par défaut : conversation neuve, entreprise sans profil lisible.
    prisma.aiMessage.findMany.mockResolvedValue([]);
    prisma.company.findUnique.mockResolvedValue(null);
    txClient.aiConversation.update.mockResolvedValue({});
  });

  describe('createConversation', () => {
    it('should create a conversation with companyId, createdById and lastMessageAt', async () => {
      const dto = { topic: 'Marketing strategy' };
      const expected = { id: 'conv-1', topic: dto.topic };
      prisma.aiConversation.create.mockResolvedValue(expected);

      const result = await service.createConversation(dto, mockUser);
      expect(result).toEqual(expected);
      expect(prisma.aiConversation.create).toHaveBeenCalledWith({
        data: {
          startedAt: expect.any(Date) as Date,
          lastMessageAt: expect.any(Date) as Date,
          topic: dto.topic,
          companyId: mockUser.companyId,
          createdById: mockUser.userId,
        },
      });
    });

    it('should throw if user has no company', async () => {
      const user = { ...mockUser, companyId: null };
      await expect(
        service.createConversation({ topic: 'test' }, user),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('listConversations', () => {
    it("should list only the user's own conversations, most recent first", async () => {
      prisma.aiConversation.findMany.mockResolvedValue([]);

      await service.listConversations(mockUser);

      expect(prisma.aiConversation.findMany).toHaveBeenCalledWith({
        where: { createdById: 'user-1', companyId: 'company-1' },
        orderBy: { lastMessageAt: 'desc' },
        take: 100,
        select: { id: true, topic: true, startedAt: true, lastMessageAt: true },
      });
    });

    it('should return an empty list for a user without company', async () => {
      await expect(
        service.listConversations({ ...mockUser, companyId: null }),
      ).resolves.toEqual([]);
      expect(prisma.aiConversation.findMany).not.toHaveBeenCalled();
    });
  });

  describe('envoyerMessage', () => {
    it('should save user message, call IA, save IA response and bump lastMessageAt', async () => {
      const dto = { content: 'Hello' };
      const userMessage = { id: 'msg-1', content: dto.content, sender: 'USER' };
      const iaMessage = {
        id: 'msg-2',
        content: 'Hi there!',
        sender: 'AI',
        sentAt: new Date('2026-09-25T10:00:00Z'),
      };

      prisma.aiConversation.findUnique.mockResolvedValue(ownConversation());
      iaEngine.askQuestion.mockResolvedValue({ answer: 'Hi there!' });
      txClient.aiMessage.create
        .mockResolvedValueOnce(userMessage)
        .mockResolvedValueOnce(iaMessage);

      const result = await service.envoyerMessage('conv-1', dto, mockUser);
      expect(result.userMessage).toEqual(userMessage);
      expect(result.iaMessage).toEqual(iaMessage);
      expect(iaEngine.askQuestion).toHaveBeenCalledWith({
        conversationId: 'conv-1',
        userMessage: dto.content,
        context: { topic: 'test' },
      });
      // Régression du bug historique : les écritures doivent passer par le
      // client transactionnel `tx`, jamais par `this.prisma` directement.
      expect(txClient.aiMessage.create).toHaveBeenCalledTimes(2);
      expect(txClient.aiConversation.update).toHaveBeenCalledWith({
        where: { id: 'conv-1' },
        data: { lastMessageAt: iaMessage.sentAt },
      });
    });

    it('should send the company profile and the recent history, oldest first, to the IA engine', async () => {
      const companyProfile = {
        name: 'Kiyanza Demo SARL',
        businessSector: 'Agroalimentaire',
        address: 'Akwa, Douala',
      };
      prisma.aiConversation.findUnique.mockResolvedValue(
        ownConversation({ topic: 'Canaux' }),
      );
      prisma.company.findUnique.mockResolvedValue(companyProfile);
      // Renvoyés du plus récent au plus ancien (orderBy sentAt desc).
      prisma.aiMessage.findMany.mockResolvedValue([
        { sender: 'AI', content: 'Bonjour ! Comment puis-je vous aider ?' },
        { sender: 'USER', content: 'Bonjour' },
      ]);
      iaEngine.askQuestion.mockResolvedValue({ answer: 'Réponse' });
      txClient.aiMessage.create.mockResolvedValue({ sentAt: new Date() });

      await service.envoyerMessage(
        'conv-1',
        { content: 'Quel réseau social choisir ?' },
        mockUser,
      );

      expect(prisma.company.findUnique).toHaveBeenCalledWith({
        where: { id: mockUser.companyId },
        select: { name: true, businessSector: true, address: true },
      });
      expect(prisma.aiMessage.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { conversationId: 'conv-1' },
          orderBy: { sentAt: 'desc' },
          take: 10,
        }),
      );
      expect(iaEngine.askQuestion).toHaveBeenCalledWith({
        conversationId: 'conv-1',
        userMessage: 'Quel réseau social choisir ?',
        context: {
          topic: 'Canaux',
          companyProfile,
          recentMessages: [
            { sender: 'USER', content: 'Bonjour' },
            { sender: 'AI', content: 'Bonjour ! Comment puis-je vous aider ?' },
          ],
        },
      });
    });

    it('should truncate long history messages sent to the IA engine', async () => {
      prisma.aiConversation.findUnique.mockResolvedValue(ownConversation());
      prisma.aiMessage.findMany.mockResolvedValue([
        { sender: 'USER', content: 'x'.repeat(5000) },
      ]);
      iaEngine.askQuestion.mockResolvedValue({ answer: 'ok' });
      txClient.aiMessage.create.mockResolvedValue({ sentAt: new Date() });

      await service.envoyerMessage('conv-1', { content: 'Suite' }, mockUser);

      const [params] = iaEngine.askQuestion.mock.calls[0];
      expect(params.context?.recentMessages?.[0].content).toHaveLength(1500);
    });

    it('should add the displayed campaign, scoped to the company, to the IA context', async () => {
      prisma.aiConversation.findUnique.mockResolvedValue(ownConversation());
      prisma.campaign.findFirst.mockResolvedValue({
        name: 'Promo rentrée',
        objective: 'Ventes',
        status: 'IN_PROGRESS',
        plannedBudget: { toNumber: () => 250000 },
        startDate: new Date('2026-09-01T00:00:00Z'),
        endDate: new Date('2026-09-30T00:00:00Z'),
        channels: [{ radio: true, poster: false, flyer: true }],
        digitalDetails: { channels: [{ platform: 'FACEBOOK' }] },
        // Du plus récent au plus ancien : la 1re valeur de CTR l'emporte.
        statistics: [
          { indicator: 'CTR', value: 0.4 },
          { indicator: 'ROAS', value: 1.2 },
          { indicator: 'CTR', value: 0.1 },
        ],
      });
      iaEngine.askQuestion.mockResolvedValue({ answer: 'Analyse' });
      txClient.aiMessage.create.mockResolvedValue({ sentAt: new Date() });

      await service.envoyerMessage(
        'conv-1',
        { content: 'Analyse cette campagne', campaignId: 'camp-1' },
        mockUser,
      );

      expect(prisma.campaign.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'camp-1', launchedBy: { companyId: 'company-1' } },
        }),
      );
      const [params] = iaEngine.askQuestion.mock.calls[0];
      expect(params.context?.campaign).toEqual({
        name: 'Promo rentrée',
        objective: 'Ventes',
        status: 'IN_PROGRESS',
        plannedBudget: 250000,
        startDate: '2026-09-01',
        endDate: '2026-09-30',
        channels: ['Radio', 'Flyers', 'FACEBOOK'],
        results: { CTR: 0.4, ROAS: 1.2 },
      });
    });

    it('should reject a campaign of another company (404) without calling the IA', async () => {
      prisma.aiConversation.findUnique.mockResolvedValue(ownConversation());
      prisma.campaign.findFirst.mockResolvedValue(null);

      await expect(
        service.envoyerMessage(
          'conv-1',
          { content: 'x', campaignId: 'other-camp' },
          mockUser,
        ),
      ).rejects.toThrow(NotFoundException);
      expect(iaEngine.askQuestion).not.toHaveBeenCalled();
    });

    it('should throw if conversation not found', async () => {
      prisma.aiConversation.findUnique.mockResolvedValue(null);
      await expect(
        service.envoyerMessage('invalid', { content: 'test' }, mockUser),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw if conversation belongs to another company', async () => {
      prisma.aiConversation.findUnique.mockResolvedValue(
        ownConversation({ companyId: 'other-company' }),
      );
      await expect(
        service.envoyerMessage('conv-1', { content: 'test' }, mockUser),
      ).rejects.toThrow(NotFoundException); // assertSameCompany throws 404
    });

    it("should throw 404 on a colleague's conversation (same company, other author)", async () => {
      prisma.aiConversation.findUnique.mockResolvedValue(
        ownConversation({ createdById: 'colleague' }),
      );
      await expect(
        service.envoyerMessage('conv-1', { content: 'test' }, mockUser),
      ).rejects.toThrow(NotFoundException);
      expect(iaEngine.askQuestion).not.toHaveBeenCalled();
    });

    it('should throw InternalServerErrorException if IA engine fails', async () => {
      prisma.aiConversation.findUnique.mockResolvedValue(ownConversation());
      iaEngine.askQuestion.mockRejectedValue(new Error('IA down'));
      await expect(
        service.envoyerMessage('conv-1', { content: 'Hello' }, mockUser),
      ).rejects.toThrow(InternalServerErrorException);
    });
  });

  describe('regenererDerniereReponse', () => {
    const question = {
      id: 'msg-1',
      sender: 'USER',
      content: 'Quel canal ?',
      sentAt: new Date('2026-09-25T10:00:00Z'),
    };
    const answer = { id: 'msg-2', sender: 'AI', content: 'Ancienne réponse' };

    it('should re-ask the last question with the history BEFORE it and replace the last AI reply', async () => {
      prisma.aiConversation.findUnique.mockResolvedValue(ownConversation());
      prisma.aiMessage.findMany
        .mockResolvedValueOnce([answer, question]) // 2 derniers messages
        .mockResolvedValueOnce([]); // historique du contexte
      iaEngine.askQuestion.mockResolvedValue({ answer: 'Nouvelle réponse' });
      txClient.aiMessage.update.mockResolvedValue({
        id: 'msg-2',
        content: 'Nouvelle réponse',
        sentAt: new Date(),
      });

      const result = await service.regenererDerniereReponse(
        'conv-1',
        {},
        mockUser,
      );

      expect(prisma.aiMessage.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: { conversationId: 'conv-1', sentAt: { lt: question.sentAt } },
        }),
      );
      expect(iaEngine.askQuestion).toHaveBeenCalledWith(
        expect.objectContaining({ userMessage: 'Quel canal ?' }),
      );
      expect(txClient.aiMessage.update).toHaveBeenCalledWith({
        where: { id: 'msg-2' },
        data: {
          content: 'Nouvelle réponse',
          sentAt: expect.any(Date) as Date,
          feedback: null,
        },
      });
      expect(result.content).toBe('Nouvelle réponse');
    });

    it('should refuse when the last message is not an AI reply', async () => {
      prisma.aiConversation.findUnique.mockResolvedValue(ownConversation());
      prisma.aiMessage.findMany.mockResolvedValueOnce([question]);

      await expect(
        service.regenererDerniereReponse('conv-1', {}, mockUser),
      ).rejects.toThrow(BadRequestException);
      expect(iaEngine.askQuestion).not.toHaveBeenCalled();
    });
  });

  describe('setMessageFeedback', () => {
    it('should store the feedback on an AI message of the conversation', async () => {
      prisma.aiConversation.findUnique.mockResolvedValue(ownConversation());
      prisma.aiMessage.findFirst.mockResolvedValue({ id: 'msg-2' });
      prisma.aiMessage.update.mockResolvedValue({
        id: 'msg-2',
        feedback: 'UP',
      });

      await service.setMessageFeedback(
        'conv-1',
        'msg-2',
        { value: 'UP' },
        mockUser,
      );

      expect(prisma.aiMessage.findFirst).toHaveBeenCalledWith({
        where: { id: 'msg-2', conversationId: 'conv-1', sender: 'AI' },
        select: { id: true },
      });
      expect(prisma.aiMessage.update).toHaveBeenCalledWith({
        where: { id: 'msg-2' },
        data: { feedback: 'UP' },
        select: { id: true, feedback: true },
      });
    });

    it('should 404 on a user message or a message of another conversation', async () => {
      prisma.aiConversation.findUnique.mockResolvedValue(ownConversation());
      prisma.aiMessage.findFirst.mockResolvedValue(null);

      await expect(
        service.setMessageFeedback(
          'conv-1',
          'msg-x',
          { value: 'DOWN' },
          mockUser,
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('renameConversation / deleteConversation', () => {
    it('should rename an own conversation', async () => {
      prisma.aiConversation.findUnique.mockResolvedValue(ownConversation());
      prisma.aiConversation.update.mockResolvedValue({});

      await service.renameConversation(
        'conv-1',
        { topic: 'Nouveau titre' },
        mockUser,
      );

      expect(prisma.aiConversation.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'conv-1' },
          data: { topic: 'Nouveau titre' },
        }),
      );
    });

    it('should delete messages then the conversation', async () => {
      prisma.aiConversation.findUnique.mockResolvedValue(ownConversation());
      prisma.aiMessage.deleteMany.mockResolvedValue({ count: 2 });
      prisma.aiConversation.delete.mockResolvedValue({});

      await service.deleteConversation('conv-1', mockUser);

      expect(prisma.aiMessage.deleteMany).toHaveBeenCalledWith({
        where: { conversationId: 'conv-1' },
      });
      expect(prisma.aiConversation.delete).toHaveBeenCalledWith({
        where: { id: 'conv-1' },
      });
    });

    it("should not delete a colleague's conversation", async () => {
      prisma.aiConversation.findUnique.mockResolvedValue(
        ownConversation({ createdById: 'colleague' }),
      );

      await expect(
        service.deleteConversation('conv-1', mockUser),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.aiConversation.delete).not.toHaveBeenCalled();
    });
  });

  describe('getConversation', () => {
    it('should return conversation with messages in chronological order', async () => {
      const expected = {
        ...ownConversation(),
        messages: [
          { id: 'msg-2', content: 'reply', sender: 'AI' },
          { id: 'msg-1', content: 'hello', sender: 'USER' },
        ],
      };
      prisma.aiConversation.findUnique
        .mockResolvedValueOnce(ownConversation()) // contrôle d'accès
        .mockResolvedValueOnce(expected); // lecture avec messages

      const result = await service.getConversation('conv-1', mockUser);

      // L'historique est borné (`take`) et trié décroissant côté base ; le
      // service ré-inverse pour restituer l'ordre chronologique.
      expect(result).toEqual({
        ...expected,
        messages: [...expected.messages].reverse(),
      });
      expect(prisma.aiConversation.findUnique).toHaveBeenLastCalledWith({
        where: { id: 'conv-1' },
        include: { messages: { orderBy: { sentAt: 'desc' }, take: 200 } },
      });
    });

    it('should throw if conversation not found', async () => {
      prisma.aiConversation.findUnique.mockResolvedValue(null);
      await expect(
        service.getConversation('invalid', mockUser),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('getRecommandations', () => {
    it('should return recommendations for a campaign', async () => {
      const campaignId = 'camp-1';
      const campaign = {
        id: campaignId,
        launchedBy: { companyId: 'company-1' },
      };
      const recommendations = [
        { id: 'rec-1', content: 'Do this', priority: 'high' },
      ];
      prisma.campaign.findFirst.mockResolvedValue(campaign);
      prisma.recommendation.findMany.mockResolvedValue(recommendations);

      const result = await service.getRecommandations(campaignId, mockUser);
      expect(result).toEqual(recommendations);
      expect(prisma.recommendation.findMany).toHaveBeenCalledWith({
        where: { campaignId },
        orderBy: { priority: 'asc' },
      });
    });

    it('should throw if campaign not found', async () => {
      prisma.campaign.findFirst.mockResolvedValue(null);
      await expect(
        service.getRecommandations('invalid', mockUser),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('genererRecommandations', () => {
    it('should generate and persist recommendations', async () => {
      const campaignId = 'camp-1';
      const campaign = {
        id: campaignId,
        name: 'Test',
        objective: 'Reach',
        plannedBudget: { toNumber: () => 1000 },
        launchedBy: { companyId: 'company-1' },
      };
      const iaResult = {
        recommendations: [
          { content: 'Rec1', priority: 'high' },
          { content: 'Rec2', priority: 'medium' },
        ],
      };
      const createdRecs = iaResult.recommendations.map((r, i) => ({
        id: `rec-${i}`,
        ...r,
      }));

      prisma.campaign.findFirst.mockResolvedValue(campaign);
      iaEngine.generateRecommendations.mockResolvedValue(iaResult);
      txClient.recommendation.create
        .mockResolvedValueOnce(createdRecs[0])
        .mockResolvedValueOnce(createdRecs[1]);

      const result = await service.genererRecommandations(campaignId, mockUser);
      expect(result).toEqual(createdRecs);
      expect(iaEngine.generateRecommendations).toHaveBeenCalledWith({
        campaignId: campaign.id,
        campaignName: campaign.name,
        objective: campaign.objective,
        plannedBudget: 1000,
      });
      expect(txClient.recommendation.create).toHaveBeenCalledTimes(2);
    });

    it('should throw if campaign not found', async () => {
      prisma.campaign.findFirst.mockResolvedValue(null);
      await expect(
        service.genererRecommandations('invalid', mockUser),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw InternalServerErrorException if IA engine fails', async () => {
      const campaign = {
        id: 'camp-1',
        name: 'Test',
        objective: 'Reach',
        plannedBudget: { toNumber: () => 1000 },
        launchedBy: { companyId: 'company-1' },
      };
      prisma.campaign.findFirst.mockResolvedValue(campaign);
      iaEngine.generateRecommendations.mockRejectedValue(new Error('IA down'));
      await expect(
        service.genererRecommandations('camp-1', mockUser),
      ).rejects.toThrow(InternalServerErrorException);
    });
  });
});
