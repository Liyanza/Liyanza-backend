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

describe('DigitalCampaignsService', () => {
  let service: DigitalCampaignsService;
  let prisma: {
    campaign: { findFirst: jest.Mock };
    digitalCampaignDetails: { upsert: jest.Mock; findUnique: jest.Mock };
    digitalCampaignChannel: { upsert: jest.Mock };
    socialAccount: { findMany: jest.Mock };
    platformMetric: { findFirst: jest.Mock };
    digitalSimulation: {
      create: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
    };
    $transaction: jest.Mock;
  };
  let simulationEngine: { simulate: jest.Mock };

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
  });
});
