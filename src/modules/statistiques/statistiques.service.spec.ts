/* eslint-disable @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import { StatistiquesService } from './statistiques.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Role, CampaignStatus, BroadcastStatus } from '@prisma/client';
import { ForbiddenException, NotFoundException } from '@nestjs/common';

// ✅ Mock de json2csv — `parse` est exposé pour pouvoir inspecter les
// lignes réellement transmises (ex: test de l'échappement anti-formule).
const mockCsvParse = jest.fn().mockReturnValue('mock-csv-data') as jest.Mock<
  string,
  [Array<Record<string, unknown>>]
>;
jest.mock('json2csv', () => ({
  Parser: jest.fn().mockImplementation(() => ({
    parse: mockCsvParse,
  })),
}));

// ✅ Mock de pdfmake : export par défaut = constructeur. Le flux
// data/end/error est simulé synchrones pour que la Promise du service
// (StatistiquesService.generateRapport) se résolve réellement dans les tests.
jest.mock('pdfmake', () => {
  return jest.fn().mockImplementation(() => ({
    createPdfKitDocument: jest.fn().mockReturnValue({
      on: jest.fn(function (
        this: unknown,
        event: string,
        cb: (arg?: unknown) => void,
      ) {
        if (event === 'data') cb(Buffer.from('mock-pdf-chunk'));
        if (event === 'end') cb();
        return this;
      }),
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
    mockCsvParse.mockClear();

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

    it('should throw ForbiddenException if the user has no company (fix minor #12)', async () => {
      // Régression : avant le correctif, un utilisateur sans companyId
      // pouvait déclencher une requête Prisma avec `companyId: null`
      // au lieu d'être rejeté explicitement.
      await expect(
        service.getCampagneStatistiques(
          'camp-1',
          { ...mockUser, companyId: null },
          {},
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.campaign.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('generateRapport', () => {
    const mockCampaignRow = {
      id: 'camp-1',
      name: 'Demo Campaign',
      status: CampaignStatus.IN_PROGRESS,
      plannedBudget: { toNumber: () => 1000 },
      actualBudget: { toNumber: () => 800 },
      startDate: new Date('2026-01-01'),
      endDate: new Date('2026-01-31'),
      broadcasts: [
        { status: BroadcastStatus.BROADCASTED },
        { status: BroadcastStatus.MISSED },
      ],
      installations: [{ status: 'INSTALLED' }],
      launchedBy: { companyId: 'company-1' },
    };

    it('should throw ForbiddenException if the user has no company', async () => {
      const user = { ...mockUser, companyId: null };
      await expect(service.generateRapport(user, 'csv')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should throw NotFoundException if campagneId does not exist', async () => {
      (prisma.campaign.findFirst as jest.Mock).mockResolvedValue(null);
      await expect(
        service.generateRapport(mockUser, 'csv', 'unknown-campaign'),
      ).rejects.toThrow(NotFoundException);
    });

    // RÉGRESSION (isolation multi-tenant) : un rapport ne doit jamais pouvoir
    // être généré pour une campagne d'une autre entreprise.
    it('should throw NotFoundException if the campaign belongs to another company', async () => {
      (prisma.campaign.findFirst as jest.Mock).mockResolvedValue({
        ...mockCampaignRow,
        launchedBy: { companyId: 'other-company' },
      });
      await expect(
        service.generateRapport(mockUser, 'csv', 'camp-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should generate a CSV report from all company campaigns when no campagneId is given', async () => {
      (prisma.campaign.findMany as jest.Mock).mockResolvedValue([
        mockCampaignRow,
      ]);

      const result = await service.generateRapport(mockUser, 'csv');

      expect(prisma.campaign.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { launchedBy: { companyId: mockUser.companyId } },
          take: 500,
        }),
      );
      expect(mockCsvParse).toHaveBeenCalled();
      expect(result).toBe('mock-csv-data');
    });

    // RÉGRESSION (correctif audit — injection de formule CSV, CWE-1236) :
    // un nom de campagne commençant par un caractère déclencheur de formule
    // (=, +, -, @) doit être préfixé d'une apostrophe avant d'être transmis
    // au parser CSV, sans quoi il s'exécute comme une formule dans
    // Excel/LibreOffice/Google Sheets à l'ouverture du fichier.
    it('should escape formula-triggering characters in campaign names before CSV export', async () => {
      (prisma.campaign.findMany as jest.Mock).mockResolvedValue([
        {
          ...mockCampaignRow,
          name: '=HYPERLINK("https://attacker.tld","x")',
        },
      ]);

      await service.generateRapport(mockUser, 'csv');

      const rowsPassedToParser = mockCsvParse.mock.calls[0][0];
      expect(rowsPassedToParser[0]['Campaign Name']).toBe(
        `'=HYPERLINK("https://attacker.tld","x")`,
      );
    });

    it('should generate a PDF report as a Buffer', async () => {
      (prisma.campaign.findFirst as jest.Mock).mockResolvedValue(
        mockCampaignRow,
      );

      const result = await service.generateRapport(mockUser, 'pdf', 'camp-1');

      expect(Buffer.isBuffer(result)).toBe(true);
      expect((result as Buffer).toString()).toBe('mock-pdf-chunk');
    });
  });
});
