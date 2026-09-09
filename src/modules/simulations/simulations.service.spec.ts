import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { SimulationsService } from './simulations.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { SIMULATION_ENGINE_TOKEN } from './clients/simulation-engine.interface';
import type { SimulationEngineInterface } from './clients/simulation-engine.interface';
import { CampaignStatus, Role } from '@prisma/client';

describe('SimulationsService', () => {
  let service: SimulationsService;
  let prisma: {
    question: { findMany: jest.Mock };
    campaign: { findFirst: jest.Mock };
    simulation: {
      create: jest.Mock;
      findUnique: jest.Mock;
      findMany: jest.Mock;
    };
    $transaction: jest.Mock;
  };
  let txClient: {
    questionnaire: { create: jest.Mock };
    simulationAnswer: { createMany: jest.Mock };
  };
  let simulationEngine: jest.Mocked<SimulationEngineInterface>;

  const user: AuthenticatedUser = {
    userId: 'user-1',
    email: 'user@test.com',
    role: Role.ADMIN,
    companyId: 'company-1',
  };

  const campaign = {
    id: 'camp-1',
    name: 'Campagne Test',
    objective: 'Notoriété',
    status: CampaignStatus.PLANNED,
    plannedBudget: { toNumber: () => 100000 },
    launchedBy: { companyId: 'company-1' },
  };

  const dto = { reponses: [{ questionId: 'q-1', value: 'oui' }] };

  beforeEach(async () => {
    txClient = {
      questionnaire: { create: jest.fn() },
      simulationAnswer: { createMany: jest.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SimulationsService,
        {
          provide: PrismaService,
          useValue: {
            question: { findMany: jest.fn() },
            campaign: { findFirst: jest.fn() },
            simulation: {
              create: jest.fn(),
              findUnique: jest.fn(),
              findMany: jest.fn(),
            },
            $transaction: jest.fn((cb: (tx: typeof txClient) => unknown) =>
              cb(txClient),
            ),
          },
        },
        {
          provide: SIMULATION_ENGINE_TOKEN,
          useValue: { simulate: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<SimulationsService>(SimulationsService);
    prisma = module.get(PrismaService);
    simulationEngine = module.get(SIMULATION_ENGINE_TOKEN);
  });

  describe('getQuestions', () => {
    it('should return all questions ordered by label', async () => {
      prisma.question.findMany.mockResolvedValue([{ id: 'q-1' }]);
      const result = await service.getQuestions();
      expect(result).toEqual([{ id: 'q-1' }]);
      expect(prisma.question.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { label: 'asc' } }),
      );
    });
  });

  describe('createSimulation', () => {
    it('should throw NotFoundException if the campaign belongs to another company', async () => {
      prisma.campaign.findFirst.mockResolvedValue(null);
      await expect(
        service.createSimulation('camp-1', dto, user),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException if the user has no company', async () => {
      prisma.campaign.findFirst.mockResolvedValue(campaign);
      await expect(
        service.createSimulation('camp-1', dto, { ...user, companyId: null }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw BadRequestException on a completed/cancelled campaign', async () => {
      prisma.campaign.findFirst.mockResolvedValue({
        ...campaign,
        status: CampaignStatus.CANCELLED,
      });
      await expect(
        service.createSimulation('camp-1', dto, user),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if a questionId does not exist', async () => {
      prisma.campaign.findFirst.mockResolvedValue(campaign);
      prisma.question.findMany.mockResolvedValue([]); // aucune question trouvée

      await expect(
        service.createSimulation('camp-1', dto, user),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('should write the questionnaire and answers through the tx client, not this.prisma', async () => {
      prisma.campaign.findFirst.mockResolvedValue(campaign);
      prisma.question.findMany.mockResolvedValue([{ id: 'q-1' }]);
      txClient.questionnaire.create.mockResolvedValue({ id: 'quest-1' });
      simulationEngine.simulate.mockResolvedValue({
        estimatedBudget: 90000,
        expectedResults: 'Bonne portée',
      });
      prisma.simulation.create.mockResolvedValue({ id: 'sim-1' });
      prisma.simulation.findUnique.mockResolvedValue({ id: 'sim-1' });

      await service.createSimulation('camp-1', dto, user);

      expect(txClient.questionnaire.create).toHaveBeenCalledTimes(1);
      expect(txClient.simulationAnswer.createMany).toHaveBeenCalledWith({
        data: [{ value: 'oui', questionnaireId: 'quest-1', questionId: 'q-1' }],
      });
    });

    // RÉGRESSION (atomicité — CORRECTIF AUDIT majeur) : le moteur doit être
    // appelé AVANT toute écriture, pour ne jamais laisser en base un
    // Questionnaire/SimulationAnswer orphelin si le moteur échoue.
    it('should call the simulation engine BEFORE creating the Simulation row, and never persist on engine failure', async () => {
      prisma.campaign.findFirst.mockResolvedValue(campaign);
      prisma.question.findMany.mockResolvedValue([{ id: 'q-1' }]);
      txClient.questionnaire.create.mockResolvedValue({ id: 'quest-1' });
      simulationEngine.simulate.mockRejectedValue(new Error('engine down'));

      await expect(
        service.createSimulation('camp-1', dto, user),
      ).rejects.toThrow(InternalServerErrorException);
      expect(prisma.simulation.create).not.toHaveBeenCalled();
    });

    it('should persist the estimated budget/results returned by the engine', async () => {
      prisma.campaign.findFirst.mockResolvedValue(campaign);
      prisma.question.findMany.mockResolvedValue([{ id: 'q-1' }]);
      txClient.questionnaire.create.mockResolvedValue({ id: 'quest-1' });
      simulationEngine.simulate.mockResolvedValue({
        estimatedBudget: 90000,
        expectedResults: 'Bonne portée',
      });
      prisma.simulation.create.mockResolvedValue({ id: 'sim-1' });
      prisma.simulation.findUnique.mockResolvedValue({ id: 'sim-1' });

      await service.createSimulation('camp-1', dto, user);

      expect(prisma.simulation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            estimatedBudget: 90000,
            expectedResults: 'Bonne portée',
            questionnaireId: 'quest-1',
          }) as unknown,
        }),
      );
    });
  });

  describe('getSimulations', () => {
    it('should throw NotFoundException if the campaign belongs to another company', async () => {
      prisma.campaign.findFirst.mockResolvedValue(null);
      await expect(service.getSimulations('camp-1', user)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should filter simulations by campaignId via the JSON parameters path, bounded and paginated', async () => {
      prisma.campaign.findFirst.mockResolvedValue(campaign);
      prisma.simulation.findMany.mockResolvedValue([{ id: 'sim-1' }]);

      const result = await service.getSimulations('camp-1', user);

      expect(prisma.simulation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { parameters: { path: ['campaignId'], equals: 'camp-1' } },
          take: 50,
        }),
      );
      expect(result).toEqual([{ id: 'sim-1' }]);
    });
  });
});
