import { Test, TestingModule } from '@nestjs/testing';
import { StatistiquesService } from './statistiques.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Role, CampaignStatus, BroadcastStatus } from '@prisma/client';
import { ForbiddenException, NotFoundException } from '@nestjs/common';

// ✅ Mock de json2csv
jest.mock('json2csv', () => ({
  Parser: jest.fn().mockImplementation(() => ({
    parse: jest.fn().mockReturnValue('mock-csv-data'),
  })),
}));

// ✅ Mock de pdfmake : export par défaut = constructeur
jest.mock('pdfmake', () => {
  return jest.fn().mockImplementation(() => ({
    createPdfKitDocument: jest.fn().mockReturnValue({
      on: jest.fn(),
      end: jest.fn(),
    }),
  }));
});

describe('StatistiquesService', () => {
  let service: StatistiquesService;
  let prisma: jest.Mocked<PrismaService>;

  const mockUser: AuthenticatedUser = {
    userId: 'user-1',
    email: 'test@test.com',
    role: Role.ADMIN,
    companyId: 'company-1',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StatistiquesService,
        {
          provide: PrismaService,
          useValue: {
            campaign: {
              findFirst: jest.fn(),
              findMany: jest.fn(),
              findUnique: jest.fn(),
            },
            statistic: {
              findMany: jest.fn(),
            },
            notification: {
              count: jest.fn(),
            },
          },
        },
      ],
    }).compile();

    service = module.get<StatistiquesService>(StatistiquesService);
    prisma = module.get(PrismaService);
  });

  describe('getDashboard', () => {
    it('should throw if user has no company', async () => {
      const user = { ...mockUser, companyId: null };
      await expect(service.getDashboard(user)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should return dashboard with empty campaigns', async () => {
      (prisma.campaign.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.notification.count as jest.Mock).mockResolvedValue(0);

      const result = await service.getDashboard(mockUser);
      expect(result.totalCampaigns).toBe(0);
      expect(result.campaignsByStatus).toEqual({});
      expect(result.complianceRate).toBe(0);
      expect(result.installationRate).toBe(0);
      expect(result.unreadNotifications).toBe(0);
    });

    it('should compute correct metrics for a campaign with broadcasts and installations', async () => {
      const now = new Date();
      const campaign = {
        id: 'camp-1',
        name: 'Test Campaign',
        status: CampaignStatus.IN_PROGRESS,
        plannedBudget: { toNumber: () => 1000 },
        actualBudget: { toNumber: () => 800 },
        startDate: now,
        endDate: now,
        launchedBy: { companyId: 'company-1' },
        broadcasts: [
          { id: 'b1', status: BroadcastStatus.BROADCASTED },
          { id: 'b2', status: BroadcastStatus.MISSED },
          { id: 'b3', status: BroadcastStatus.PLANNED },
        ],
        installations: [
          { id: 'i1', status: 'INSTALLED' },
          { id: 'i2', status: 'PLANNED' },
        ],
      };
      (prisma.campaign.findMany as jest.Mock).mockResolvedValue([campaign]);
      (prisma.notification.count as jest.Mock).mockResolvedValue(5);

      const result = await service.getDashboard(mockUser);
      expect(result.totalCampaigns).toBe(1);
      expect(result.totalPlannedBudget).toBe(1000);
      expect(result.totalActualBudget).toBe(800);
      expect(result.budgetDeviation).toBe(200);
      expect(result.complianceRate).toBe(1 / 3);
      expect(result.installationRate).toBe(0.5);
      expect(result.unreadNotifications).toBe(5);
      expect(result.campaignsByStatus[CampaignStatus.IN_PROGRESS]).toBe(1);
    });
  });

  describe('getCampagneStatistiques', () => {
    it('should return statistics for a campaign', async () => {
      const campaign = {
        id: 'camp-1',
        launchedBy: { companyId: 'company-1' },
      };
      const stats = [
        { id: 's1', indicator: 'reach', value: 5000, computedAt: new Date() },
      ];
      (prisma.campaign.findFirst as jest.Mock).mockResolvedValue(campaign);
      (prisma.statistic.findMany as jest.Mock).mockResolvedValue(stats);

      const result = await service.getCampagneStatistiques(
        'camp-1',
        mockUser,
        {},
      );
      expect(result).toEqual(stats);
    });

    it('should throw NotFoundException if campaign not found', async () => {
      (prisma.campaign.findFirst as jest.Mock).mockResolvedValue(null);
      await expect(
        service.getCampagneStatistiques('invalid', mockUser, {}),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
