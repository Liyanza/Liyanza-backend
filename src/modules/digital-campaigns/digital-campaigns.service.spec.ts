import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { DigitalCampaignsService } from './digital-campaigns.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { DIGITAL_SIMULATION_ENGINE_TOKEN } from './clients/digital-simulation-engine.interface';
import {
  BudgetAllocationType,
  CampaignStatus,
  CampaignType,
  DigitalObjective,
  Role,
  SocialPlatform,
} from '@prisma/client';
import { SimulationAnalysisClient } from './clients/simulation-analysis.client';

describe('DigitalCampaignsService', () => {
  let service: DigitalCampaignsService;
  let prisma: {
    campaign: { findFirst: jest.Mock };
    digitalCampaignDetails: { upsert: jest.Mock; findUnique: jest.Mock };
    digitalCampaignChannel: { upsert: jest.Mock };
    socialAccount: { findMany: jest.Mock };
    platformMetric: { findFirst: jest.Mock };
    company: { findUnique: jest.Mock };
    digitalSimulation: {
      create: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
    };
    $transaction: jest.Mock;
  };
  let simulationEngine: { simulate: jest.Mock };
  let simulationAnalysis: { analyze: jest.Mock };

  const user: AuthenticatedUser = {
    userId: 'user-1',
    email: 'manager@test.com',
    role: Role.MARKETING_MANAGER,
    companyId: 'company-1',
  };

  const digitalCampaign = {
    id: 'camp-1',
    type: CampaignType.DIGITAL,
    status: CampaignStatus.DRAFT,
    plannedBudget: { toNumber: () => 1000 },
  };

  beforeEach(async () => {
    simulationEngine = { simulate: jest.fn() };
    // Par défaut : service IA non configuré (aucune analyse).
    simulationAnalysis = { analyze: jest.fn().mockResolvedValue(null) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DigitalCampaignsService,
        {
          provide: PrismaService,
          useValue: {
            campaign: { findFirst: jest.fn() },
            digitalCampaignDetails: {
              upsert: jest.fn(),
              findUnique: jest.fn(),
            },
            digitalCampaignChannel: { upsert: jest.fn() },
            socialAccount: { findMany: jest.fn() },
            platformMetric: { findFirst: jest.fn() },
            company: { findUnique: jest.fn().mockResolvedValue(null) },
            digitalSimulation: {
              create: jest.fn(),
              findMany: jest.fn(),
              count: jest.fn(),
            },
            $transaction: jest.fn(),
          },
        },
        {
          provide: DIGITAL_SIMULATION_ENGINE_TOKEN,
          useValue: simulationEngine,
        },
        { provide: SimulationAnalysisClient, useValue: simulationAnalysis },
      ],
    }).compile();

    service = module.get<DigitalCampaignsService>(DigitalCampaignsService);
    prisma = module.get(PrismaService);
  });

  describe('access control', () => {
    it('should throw ForbiddenException if the user has no company', async () => {
      await expect(
        service.upsertDetails(
          'camp-1',
          {
            objective: DigitalObjective.AWARENESS,
            ageMin: 18,
            ageMax: 45,
            targetGender: 'ALL',
            targetLocations: [],
            targetInterests: [],
            budgetAllocation: BudgetAllocationType.TOTAL,
          },
          { ...user, companyId: null },
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw NotFoundException on cross-tenant access (never leak existence)', async () => {
      prisma.campaign.findFirst.mockResolvedValue(null);

      await expect(service.getDetails('camp-1', user)).rejects.toThrow(
        NotFoundException,
      );

      // Régression multi-tenant : le scope entreprise doit être appliqué à
      // la lecture, pas seulement vérifié en mémoire après coup.
      expect(prisma.campaign.findFirst).toHaveBeenCalledWith({
        where: { id: 'camp-1', launchedBy: { companyId: 'company-1' } },
      });
    });

    it('should reject a non-DIGITAL campaign', async () => {
      prisma.campaign.findFirst.mockResolvedValue({
        ...digitalCampaign,
        type: CampaignType.RADIO,
      });

      await expect(service.getDetails('camp-1', user)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('upsertDetails', () => {
    it('should reject ageMin > ageMax', async () => {
      prisma.campaign.findFirst.mockResolvedValue(digitalCampaign);

      await expect(
        service.upsertDetails(
          'camp-1',
          {
            objective: DigitalObjective.AWARENESS,
            ageMin: 50,
            ageMax: 20,
            targetGender: 'ALL',
            targetLocations: [],
            targetInterests: [],
            budgetAllocation: BudgetAllocationType.TOTAL,
          },
          user,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.digitalCampaignDetails.upsert).not.toHaveBeenCalled();
    });

    it('should reject editing a campaign that is no longer DRAFT', async () => {
      prisma.campaign.findFirst.mockResolvedValue({
        ...digitalCampaign,
        status: CampaignStatus.PLANNED,
      });

      await expect(
        service.upsertDetails(
          'camp-1',
          {
            objective: DigitalObjective.AWARENESS,
            ageMin: 18,
            ageMax: 45,
            targetGender: 'ALL',
            targetLocations: [],
            targetInterests: [],
            budgetAllocation: BudgetAllocationType.TOTAL,
          },
          user,
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('selectChannels', () => {
    const details = { id: 'details-1', campaignId: 'camp-1' };

    it('should reject duplicate platforms in the same request', async () => {
      prisma.campaign.findFirst.mockResolvedValue(digitalCampaign);
      prisma.digitalCampaignDetails.findUnique.mockResolvedValue(details);

      await expect(
        service.selectChannels(
          'camp-1',
          {
            channels: [
              { platform: SocialPlatform.FACEBOOK },
              { platform: SocialPlatform.FACEBOOK },
            ],
          },
          user,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject a socialAccountId belonging to another company', async () => {
      prisma.campaign.findFirst.mockResolvedValue(digitalCampaign);
      prisma.digitalCampaignDetails.findUnique.mockResolvedValue(details);
      // Scope entreprise appliqué dans la requête elle-même : un compte
      // d'une autre entreprise ne remonte simplement jamais dans la liste.
      prisma.socialAccount.findMany.mockResolvedValue([]);

      await expect(
        service.selectChannels(
          'camp-1',
          {
            channels: [
              {
                platform: SocialPlatform.FACEBOOK,
                socialAccountId: 'sa-other-company',
              },
            ],
          },
          user,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('should reject a socialAccountId whose platform does not match', async () => {
      prisma.campaign.findFirst.mockResolvedValue(digitalCampaign);
      prisma.digitalCampaignDetails.findUnique.mockResolvedValue(details);
      prisma.socialAccount.findMany.mockResolvedValue([
        {
          id: 'sa-1',
          platform: SocialPlatform.INSTAGRAM,
          companyId: 'company-1',
        },
      ]);

      await expect(
        service.selectChannels(
          'camp-1',
          {
            channels: [
              { platform: SocialPlatform.FACEBOOK, socialAccountId: 'sa-1' },
            ],
          },
          user,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should upsert channels through a single transaction', async () => {
      prisma.campaign.findFirst.mockResolvedValue(digitalCampaign);
      prisma.digitalCampaignDetails.findUnique.mockResolvedValue(details);
      prisma.socialAccount.findMany.mockResolvedValue([
        {
          id: 'sa-1',
          platform: SocialPlatform.FACEBOOK,
          companyId: 'company-1',
        },
      ]);
      prisma.$transaction.mockResolvedValue([
        { id: 'chan-1', platform: SocialPlatform.FACEBOOK },
      ]);

      const result = await service.selectChannels(
        'camp-1',
        {
          channels: [
            { platform: SocialPlatform.FACEBOOK, socialAccountId: 'sa-1' },
          ],
        },
        user,
      );

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(result).toEqual([
        { id: 'chan-1', platform: SocialPlatform.FACEBOOK },
      ]);
    });
  });

  describe('createSimulation', () => {
    it('should reject a campaign without digital details', async () => {
      prisma.campaign.findFirst.mockResolvedValue(digitalCampaign);
      prisma.digitalCampaignDetails.findUnique.mockResolvedValue(null);

      await expect(service.createSimulation('camp-1', user)).rejects.toThrow(
        BadRequestException,
      );
      expect(simulationEngine.simulate).not.toHaveBeenCalled();
    });

    it('should reject a campaign without any selected channel', async () => {
      prisma.campaign.findFirst.mockResolvedValue(digitalCampaign);
      prisma.digitalCampaignDetails.findUnique.mockResolvedValue({
        id: 'details-1',
        channels: [],
      });

      await expect(service.createSimulation('camp-1', user)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should degrade metrics to null for a channel with no linked social account', async () => {
      prisma.campaign.findFirst.mockResolvedValue(digitalCampaign);
      prisma.digitalCampaignDetails.findUnique.mockResolvedValue({
        id: 'details-1',
        objective: DigitalObjective.AWARENESS,
        ageMin: 18,
        ageMax: 45,
        targetGender: 'ALL',
        targetLocations: [],
        targetInterests: [],
        budgetAllocation: BudgetAllocationType.TOTAL,
        channels: [{ platform: SocialPlatform.FACEBOOK, socialAccount: null }],
      });
      simulationEngine.simulate.mockResolvedValue({
        predictedReach: 100,
        predictedEngagementRate: 1,
        predictedCtr: 1,
        predictedRoas: 1,
        narrativeSummary: 'summary',
        warnings: ['no metrics'],
      });
      prisma.digitalSimulation.create.mockResolvedValue({ id: 'sim-1' });

      await service.createSimulation('camp-1', user);

      expect(simulationEngine.simulate).toHaveBeenCalledWith(
        expect.objectContaining({
          channels: [{ platform: SocialPlatform.FACEBOOK, metrics: null }],
        }),
      );
    });

    it('should call the simulation engine before persisting (atomicity)', async () => {
      prisma.campaign.findFirst.mockResolvedValue(digitalCampaign);
      prisma.digitalCampaignDetails.findUnique.mockResolvedValue({
        id: 'details-1',
        objective: DigitalObjective.AWARENESS,
        ageMin: 18,
        ageMax: 45,
        targetGender: 'ALL',
        targetLocations: [],
        targetInterests: [],
        budgetAllocation: BudgetAllocationType.TOTAL,
        channels: [{ platform: SocialPlatform.FACEBOOK, socialAccount: null }],
      });
      const callOrder: string[] = [];
      simulationEngine.simulate.mockImplementation(() => {
        callOrder.push('engine');
        return Promise.resolve({
          predictedReach: 100,
          predictedEngagementRate: 1,
          predictedCtr: 1,
          predictedRoas: 1,
          narrativeSummary: 'summary',
          warnings: [],
        });
      });
      prisma.digitalSimulation.create.mockImplementation(() => {
        callOrder.push('persist');
        return Promise.resolve({ id: 'sim-1' });
      });

      await service.createSimulation('camp-1', user);

      expect(callOrder).toEqual(['engine', 'persist']);
    });

    describe('AI analysis', () => {
      const engineResult = {
        predictedReach: 61200,
        predictedEngagementRate: 3.1,
        predictedCtr: 1.4,
        predictedRoas: 1.8,
        avgCpc: 145,
        costPerAcquisition: 5200,
        conversionRate: 2.8,
        narrativeSummary: 'Texte de repli du moteur',
        warnings: ['Aucun compte lié'],
        scenarios: [{ id: 'A', label: 'Équilibré', isRecommended: true }],
        channelBreakdown: [{ platform: 'FACEBOOK', budgetAmount: 1000 }],
        weeklySeries: [],
      };
      const analysis = {
        summary: 'Cette campagne peut toucher environ 61 200 personnes.',
        strengths: ['Budget équilibré'],
        risks: ['Instagram non lié'],
        recommendations: [
          { title: 'Lier Instagram', detail: 'Pour fiabiliser.' },
        ],
        scenarioChoice: 'Le scénario Équilibré est le meilleur compromis.',
      };

      beforeEach(() => {
        prisma.campaign.findFirst.mockResolvedValue({
          ...digitalCampaign,
          name: 'Promo rentrée',
          startDate: new Date('2026-10-01T00:00:00Z'),
          endDate: new Date('2026-10-31T00:00:00Z'),
        });
        prisma.digitalCampaignDetails.findUnique.mockResolvedValue({
          id: 'details-1',
          objective: DigitalObjective.CONVERSION,
          ageMin: 18,
          ageMax: 45,
          targetGender: 'ALL',
          targetLocations: ['Douala'],
          targetInterests: ['pâtisserie'],
          budgetAllocation: BudgetAllocationType.TOTAL,
          channels: [
            { platform: SocialPlatform.FACEBOOK, socialAccount: null },
          ],
        });
        simulationEngine.simulate.mockResolvedValue(engineResult);
        prisma.digitalSimulation.create.mockResolvedValue({ id: 'sim-1' });
      });

      it('should send the simulation, scoped to the company, and store the analysis', async () => {
        const companyProfile = {
          name: 'Boulangerie Akwa',
          businessSector: 'Agroalimentaire',
          address: 'Douala',
        };
        prisma.company.findUnique.mockResolvedValue(companyProfile);
        simulationAnalysis.analyze.mockResolvedValue(analysis);

        await service.createSimulation('camp-1', user);

        expect(prisma.company.findUnique).toHaveBeenCalledWith(
          expect.objectContaining({ where: { id: 'company-1' } }),
        );
        expect(simulationAnalysis.analyze).toHaveBeenCalledWith(
          expect.objectContaining({
            campaignName: 'Promo rentrée',
            objective: DigitalObjective.CONVERSION,
            budget: { amount: 1000, allocation: BudgetAllocationType.TOTAL },
            startDate: '2026-10-01',
            endDate: '2026-10-31',
            channels: ['FACEBOOK'],
            companyProfile,
            results: expect.objectContaining({
              predictedReach: 61200,
              warnings: ['Aucun compte lié'],
            }) as object,
            scenarios: engineResult.scenarios,
          }),
        );
        expect(prisma.digitalSimulation.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            narrativeSummary: analysis.summary,
            aiAnalysis: analysis,
          }) as object,
        });
      });

      it('should still save the simulation, with the engine text, when the analysis fails', async () => {
        simulationAnalysis.analyze.mockRejectedValue(
          new Error('IA service responded 503'),
        );

        await service.createSimulation('camp-1', user);

        const [{ data }] = prisma.digitalSimulation.create.mock.calls[0] as [
          { data: Record<string, unknown> },
        ];
        expect(data.narrativeSummary).toBe('Texte de repli du moteur');
        expect(data).not.toHaveProperty('aiAnalysis');
      });

      it('should save without analysis when the IA service is not configured', async () => {
        await service.createSimulation('camp-1', user);

        const [{ data }] = prisma.digitalSimulation.create.mock.calls[0] as [
          { data: Record<string, unknown> },
        ];
        expect(data.narrativeSummary).toBe('Texte de repli du moteur');
        expect(data).not.toHaveProperty('aiAnalysis');
      });

      it('should analyse after the engine and before persisting', async () => {
        const callOrder: string[] = [];
        simulationEngine.simulate.mockImplementation(() => {
          callOrder.push('engine');
          return Promise.resolve(engineResult);
        });
        simulationAnalysis.analyze.mockImplementation(() => {
          callOrder.push('analysis');
          return Promise.resolve(analysis);
        });
        prisma.digitalSimulation.create.mockImplementation(() => {
          callOrder.push('persist');
          return Promise.resolve({ id: 'sim-1' });
        });

        await service.createSimulation('camp-1', user);

        expect(callOrder).toEqual(['engine', 'analysis', 'persist']);
      });
    });
  });
});
