import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { CampagnesService } from './campagnes.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { BroadcastStatus, CampaignStatus, Role } from '@prisma/client';

type MockedPrisma = {
  campaign: {
    create: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
    findUniqueOrThrow: jest.Mock;
  };
  advertisingChannel: { count: jest.Mock };
  broadcast: { count: jest.Mock; updateMany: jest.Mock };
};

/**
 * Client transactionnel simulé, volontairement DISTINCT de `prisma` : si le
 * service régresse et réutilise `this.prisma` à l'intérieur du callback
 * `$transaction`, les assertions sur `txClient` échoueront — c'est exactement
 * le défaut d'atomicité que le correctif d'audit vise à empêcher.
 */
type MockedTx = {
  campaign: { updateMany: jest.Mock };
  broadcast: { updateMany: jest.Mock };
};

describe('CampagnesService', () => {
  let service: CampagnesService;
  let prisma: MockedPrisma;
  let txClient: MockedTx;

  const user: AuthenticatedUser = {
    userId: 'u1',
    email: 'admin@test.com',
    role: Role.ADMIN,
    companyId: 'company-1',
  };

  beforeEach(async () => {
    txClient = {
      campaign: { updateMany: jest.fn() },
      broadcast: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CampagnesService,
        {
          provide: PrismaService,
          useValue: {
            campaign: {
              create: jest.fn(),
              findFirst: jest.fn(),
              findMany: jest.fn(),
              count: jest.fn(),
              update: jest.fn(),
              updateMany: jest.fn(),
              findUniqueOrThrow: jest.fn(),
            },
            // CORRECTIF AUDIT : la garde DRAFT -> PLANNED vérifie désormais
            // que la campagne possède au moins un canal et un planning (la
            // version précédente testait des invariants toujours vrais : du
            // code mort intégral).
            advertisingChannel: { count: jest.fn().mockResolvedValue(1) },
            broadcast: {
              count: jest.fn().mockResolvedValue(1),
              updateMany: jest.fn().mockResolvedValue({ count: 0 }),
            },
            // CORRECTIF AUDIT : `lancer()` propage désormais l'annulation aux
            // diffisions encore planifiées, de façon atomique.
            $transaction: jest.fn((cb: (tx: unknown) => unknown) =>
              cb(txClient),
            ),
          },
        },
      ],
    }).compile();

    service = module.get<CampagnesService>(CampagnesService);
    prisma = module.get(PrismaService);
  });

  describe('findAll', () => {
    it('should throw ForbiddenException if user has no company', async () => {
      await expect(
        service.findAll({ ...user, companyId: null }, 1, 10),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should scope the query to the user company and bound pagination', async () => {
      prisma.campaign.findMany.mockResolvedValue([]);
      prisma.campaign.count.mockResolvedValue(0);

      await service.findAll(user, 2, 10, CampaignStatus.DRAFT);

      expect(prisma.campaign.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            launchedBy: { companyId: user.companyId },
            status: CampaignStatus.DRAFT,
          },
          skip: 10,
          take: 10,
        }),
      );
    });
  });

  describe('update', () => {
    const draftCampaign = {
      id: 'camp-1',
      name: 'Old',
      objective: 'Awareness',
      status: CampaignStatus.DRAFT,
      startDate: new Date('2026-01-01'),
      endDate: new Date('2026-02-01'),
      plannedBudget: 1000,
    };

    it('should throw NotFoundException if campaign not found in user company', async () => {
      prisma.campaign.findFirst.mockResolvedValue(null);
      await expect(
        service.update('camp-1', { name: 'New' }, user),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if campaign is not DRAFT', async () => {
      prisma.campaign.findFirst.mockResolvedValue({
        ...draftCampaign,
        status: CampaignStatus.PLANNED,
      });
      await expect(
        service.update('camp-1', { name: 'New' }, user),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw ConflictException when the row changed status concurrently (optimistic lock)', async () => {
      // Régression de la faille "race condition / TOCTOU" de l'audit :
      // la lecture voit DRAFT, mais entre-temps une autre requête a déjà
      // fait avancer le statut -> updateMany ne doit rien affecter.
      prisma.campaign.findFirst.mockResolvedValue(draftCampaign);
      prisma.campaign.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.update('camp-1', { name: 'New' }, user),
      ).rejects.toThrow(ConflictException);

      // Le prédicat multi-tenant est réaffirmé dans la clause d'écriture
      // (défense en profondeur — correctif d'audit).
      expect(prisma.campaign.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: 'camp-1',
            status: CampaignStatus.DRAFT,
            launchedBy: { companyId: user.companyId },
          },
        }),
      );
    });

    it('should update and return the fresh row when no concurrent change occurred', async () => {
      prisma.campaign.findFirst.mockResolvedValue(draftCampaign);
      prisma.campaign.updateMany.mockResolvedValue({ count: 1 });
      const updated = { ...draftCampaign, name: 'New' };
      prisma.campaign.findUniqueOrThrow.mockResolvedValue(updated);

      const result = await service.update('camp-1', { name: 'New' }, user);
      expect(result).toEqual(updated);
    });
  });

  describe('lancer', () => {
    const plannedCampaign = {
      id: 'camp-1',
      name: 'Campaign',
      objective: 'Awareness',
      status: CampaignStatus.PLANNED,
      startDate: new Date('2026-01-01'),
      endDate: new Date('2026-02-01'),
      plannedBudget: 1000,
    };

    it('should throw NotFoundException if campaign not found', async () => {
      prisma.campaign.findFirst.mockResolvedValue(null);
      await expect(
        service.lancer('camp-1', { status: CampaignStatus.IN_PROGRESS }, user),
      ).rejects.toThrow(NotFoundException);
    });

    it('should reject an invalid transition via the state machine', async () => {
      prisma.campaign.findFirst.mockResolvedValue({
        ...plannedCampaign,
        status: CampaignStatus.COMPLETED,
      });
      await expect(
        service.lancer('camp-1', { status: CampaignStatus.DRAFT }, user),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw ConflictException on a concurrent double transition (race condition fix)', async () => {
      prisma.campaign.findFirst.mockResolvedValue(plannedCampaign);
      txClient.campaign.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.lancer('camp-1', { status: CampaignStatus.IN_PROGRESS }, user),
      ).rejects.toThrow(ConflictException);

      expect(txClient.campaign.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'camp-1',
          status: plannedCampaign.status,
          launchedBy: { companyId: user.companyId },
        },
        data: { status: CampaignStatus.IN_PROGRESS },
      });
    });

    // RÉGRESSION (majeur — transition sans effet de bord) : annuler une
    // campagne n'écrivait QUE `Campaign.status`. Les diffusions restaient
    // `PLANNED` et basculaient ensuite en « MISSED » dans le rapport de
    // conformité, dégradant le taux d'une campagne pourtant annulée.
    it('should cancel pending broadcasts when the campaign is cancelled', async () => {
      prisma.campaign.findFirst.mockResolvedValue(plannedCampaign);
      txClient.campaign.updateMany.mockResolvedValue({ count: 1 });
      prisma.campaign.findUniqueOrThrow.mockResolvedValue({
        ...plannedCampaign,
        status: CampaignStatus.CANCELLED,
      });

      await service.lancer(
        'camp-1',
        { status: CampaignStatus.CANCELLED },
        user,
      );

      expect(txClient.broadcast.updateMany).toHaveBeenCalledWith({
        where: { campaignId: 'camp-1', status: BroadcastStatus.PLANNED },
        data: { status: BroadcastStatus.CANCELLED },
      });
    });

    // Les diffusions déjà constatées sont des faits : on ne réécrit pas
    // l'historique lors d'une transition non destructrice.
    it('should not touch broadcasts on a non-cancelling transition', async () => {
      prisma.campaign.findFirst.mockResolvedValue(plannedCampaign);
      txClient.campaign.updateMany.mockResolvedValue({ count: 1 });
      prisma.campaign.findUniqueOrThrow.mockResolvedValue(plannedCampaign);

      await service.lancer(
        'camp-1',
        { status: CampaignStatus.IN_PROGRESS },
        user,
      );

      expect(txClient.broadcast.updateMany).not.toHaveBeenCalled();
    });

    it('should transition successfully when no concurrent change occurred', async () => {
      prisma.campaign.findFirst.mockResolvedValue(plannedCampaign);
      txClient.campaign.updateMany.mockResolvedValue({ count: 1 });
      const updated = {
        ...plannedCampaign,
        status: CampaignStatus.IN_PROGRESS,
      };
      prisma.campaign.findUniqueOrThrow.mockResolvedValue(updated);

      const result = await service.lancer(
        'camp-1',
        { status: CampaignStatus.IN_PROGRESS },
        user,
      );
      expect(result.status).toBe(CampaignStatus.IN_PROGRESS);
    });
  });

  describe('create', () => {
    it('should throw BadRequestException if plannedBudget <= 0', async () => {
      await expect(
        service.create(
          {
            name: 'C',
            objective: 'Awareness',
            startDate: '2026-01-01',
            endDate: '2026-02-01',
            plannedBudget: 0,
          },
          user,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if startDate > endDate', async () => {
      await expect(
        service.create(
          {
            name: 'C',
            objective: 'Awareness',
            startDate: '2026-02-01',
            endDate: '2026-01-01',
            plannedBudget: 100,
          },
          user,
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
