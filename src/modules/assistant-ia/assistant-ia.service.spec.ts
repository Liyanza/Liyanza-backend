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
  };
  aiMessage: {
    create: jest.Mock;
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
  aiMessage: { create: jest.fn() },
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
            },
            aiMessage: {
              // Volontairement PAS de mock ici : si le service régresse et
              // se remet à appeler `this.prisma.aiMessage.create` au lieu de
              // `tx.aiMessage.create`, cet appel renverra `undefined` et les
              // assertions sur `txClient.aiMessage.create` échoueront.
              create: undefined as unknown as jest.Mock,
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
            // DISTINCT de `this.prisma`.
            $transaction: jest.fn(
              (callback: (tx: typeof txClient) => unknown) =>
                callback(txClient),
            ),
          },
        },
        {
          provide: IA_ENGINE_TOKEN,
          useValue: {
            askQuestion: jest.fn(),
            generateRecommendations: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<AssistantIService>(AssistantIService);
    prisma = module.get(PrismaService);
    iaEngine = module.get(IA_ENGINE_TOKEN);
  });

  describe('createConversation', () => {
    it('should create a conversation with companyId and createdById', async () => {
      const dto = { topic: 'Marketing strategy' };
      const expected = {
        id: 'conv-1',
        startedAt: new Date(),
        topic: dto.topic,
      };
      prisma.aiConversation.create.mockResolvedValue(expected);

      const result = await service.createConversation(dto, mockUser);
      expect(result).toEqual(expected);
      expect(prisma.aiConversation.create).toHaveBeenCalledWith({
        data: {
          startedAt: expect.any(Date) as Date,
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

  describe('envoyerMessage', () => {
    it('should save user message, call IA, save IA response', async () => {
      const conversationId = 'conv-1';
      const dto = { content: 'Hello' };
      const conversation = {
        id: conversationId,
        topic: 'test',
        companyId: 'company-1',
      };
      const iaResponse = { answer: 'Hi there!' };
      const userMessage = { id: 'msg-1', content: dto.content, sender: 'USER' };
      const iaMessage = {
        id: 'msg-2',
        content: iaResponse.answer,
        sender: 'AI',
      };

      prisma.aiConversation.findUnique.mockResolvedValue(conversation);
      iaEngine.askQuestion.mockResolvedValue(iaResponse);
      txClient.aiMessage.create
        .mockResolvedValueOnce(userMessage)
        .mockResolvedValueOnce(iaMessage);

      const result = await service.envoyerMessage(
        conversationId,
        dto,
        mockUser,
      );
      expect(result.userMessage).toEqual(userMessage);
      expect(result.iaMessage).toEqual(iaMessage);
      expect(iaEngine.askQuestion).toHaveBeenCalledWith({
        conversationId,
        userMessage: dto.content,
        context: { topic: conversation.topic },
      });
      // Régression du bug historique : les écritures doivent passer par le
      // client transactionnel `tx`, jamais par `this.prisma` directement.
      expect(txClient.aiMessage.create).toHaveBeenCalledTimes(2);
    });

    it('should throw if conversation not found', async () => {
      prisma.aiConversation.findUnique.mockResolvedValue(null);
      await expect(
        service.envoyerMessage('invalid', { content: 'test' }, mockUser),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw if conversation belongs to another company', async () => {
      const conversation = { id: 'conv-1', companyId: 'other-company' };
      prisma.aiConversation.findUnique.mockResolvedValue(conversation);
      await expect(
        service.envoyerMessage('conv-1', { content: 'test' }, mockUser),
      ).rejects.toThrow(NotFoundException); // assertSameCompany throws 404
    });

    it('should throw InternalServerErrorException if IA engine fails', async () => {
      const conversationId = 'conv-1';
      const dto = { content: 'Hello' };
      prisma.aiConversation.findUnique.mockResolvedValue({
        id: conversationId,
        topic: 'test',
        companyId: 'company-1',
      });
      iaEngine.askQuestion.mockRejectedValue(new Error('IA down'));
      await expect(
        service.envoyerMessage(conversationId, dto, mockUser),
      ).rejects.toThrow(InternalServerErrorException);
    });
  });

  describe('getConversation', () => {
    it('should return conversation with messages', async () => {
      const conversationId = 'conv-1';
      const expected = {
        id: conversationId,
        topic: 'test',
        companyId: 'company-1',
        messages: [{ id: 'msg-1', content: 'hello', sender: 'USER' }],
      };
      prisma.aiConversation.findUnique.mockResolvedValue(expected);

      const result = await service.getConversation(conversationId, mockUser);

      // CORRECTIF AUDIT : l'historique est désormais borné (`take`) pour ne
      // plus charger une conversation entière en mémoire. `take` impose un
      // tri décroissant côté base ; le service ré-inverse pour restituer
      // l'ordre chronologique attendu par le client.
      expect(result).toEqual({
        ...expected,
        messages: [...expected.messages].reverse(),
      });
      expect(prisma.aiConversation.findUnique).toHaveBeenCalledWith({
        where: { id: conversationId },
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
