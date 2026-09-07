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
import { CampaignStatus, Role } from '@prisma/client';

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
};

describe('CampagnesService', () => {
  let service: CampagnesService;
  let prisma: MockedPrisma;

  const user: AuthenticatedUser = {
    userId: 'u1',
    email: 'admin@test.com',
    role: Role.ADMIN,
    companyId: 'company-1',
  };

  beforeEach(async () => {
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

      expect(prisma.campaign.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'camp-1', status: CampaignStatus.DRAFT },
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
      prisma.campaign.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.lancer('camp-1', { status: CampaignStatus.IN_PROGRESS }, user),
      ).rejects.toThrow(ConflictException);

      expect(prisma.campaign.updateMany).toHaveBeenCalledWith({
        where: { id: 'camp-1', status: plannedCampaign.status },
        data: { status: CampaignStatus.IN_PROGRESS },
      });
    });

    it('should transition successfully when no concurrent change occurred', async () => {
      prisma.campaign.findFirst.mockResolvedValue(plannedCampaign);
      prisma.campaign.updateMany.mockResolvedValue({ count: 1 });
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
