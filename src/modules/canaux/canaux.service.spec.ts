import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { CanauxService } from './canaux.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { CampaignStatus, Role } from '@prisma/client';

describe('CanauxService', () => {
  let service: CanauxService;
  let prisma: {
    campaign: { findFirst: jest.Mock };
    advertisingChannel: { create: jest.Mock; findMany: jest.Mock };
    broadcast: { create: jest.Mock; findMany: jest.Mock; count: jest.Mock };
    $transaction: jest.Mock;
  };

  const user: AuthenticatedUser = {
    userId: 'user-1',
    email: 'user@test.com',
    role: Role.ADMIN,
    companyId: 'company-1',
  };

  const campaign = {
    id: 'camp-1',
    status: CampaignStatus.PLANNED,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CanauxService,
        {
          provide: PrismaService,
          useValue: {
            campaign: { findFirst: jest.fn() },
            advertisingChannel: { create: jest.fn(), findMany: jest.fn() },
            broadcast: {
              create: jest.fn(),
              findMany: jest.fn(),
              count: jest.fn(),
            },
            $transaction: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<CanauxService>(CanauxService);
    prisma = module.get(PrismaService);
  });

  describe('associateChannels', () => {
    const dto = { channels: [{ radio: true, poster: false, flyer: false }] };

    it('should throw ForbiddenException if the user has no company', async () => {
      await expect(
        service.associateChannels('camp-1', dto, {
          ...user,
          companyId: null,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw NotFoundException if the campaign does not exist or belongs to another company', async () => {
      prisma.campaign.findFirst.mockResolvedValue(null);
      await expect(
        service.associateChannels('camp-1', dto, user),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.campaign.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'camp-1', launchedBy: { companyId: 'company-1' } },
        }),
      );
    });

    it('should throw BadRequestException if the campaign is COMPLETED or CANCELLED', async () => {
      prisma.campaign.findFirst.mockResolvedValue({
        ...campaign,
        status: CampaignStatus.CANCELLED,
      });
      await expect(
        service.associateChannels('camp-1', dto, user),
      ).rejects.toThrow(BadRequestException);
    });

    it('should create the channels in a single transaction', async () => {
      prisma.campaign.findFirst.mockResolvedValue(campaign);
      prisma.$transaction.mockResolvedValue([
        { id: 'chan-1', radio: true, poster: false, flyer: false },
      ]);

      const result = await service.associateChannels('camp-1', dto, user);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(result).toEqual([
        { id: 'chan-1', radio: true, poster: false, flyer: false },
      ]);
    });
  });

  describe('createSchedule', () => {
    const scheduleDto = {
      broadcasts: [
        {
          mediaType: 'RADIO',
          scheduledAt: '2026-09-15T10:00:00.000Z',
          duration: 30,
          channelId: 'chan-1',
        },
      ],
    };

    it('should throw NotFoundException if the campaign belongs to another company', async () => {
      prisma.campaign.findFirst.mockResolvedValue(null);
      await expect(
        service.createSchedule('camp-1', scheduleDto as never, user),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if a channelId does not belong to the campaign', async () => {
      prisma.campaign.findFirst.mockResolvedValue(campaign);
      prisma.advertisingChannel.findMany.mockResolvedValue([
        { id: 'other-channel' },
      ]);

      await expect(
        service.createSchedule('camp-1', scheduleDto as never, user),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('should create the broadcasts when all channelIds belong to the campaign', async () => {
      prisma.campaign.findFirst.mockResolvedValue(campaign);
      prisma.advertisingChannel.findMany.mockResolvedValue([{ id: 'chan-1' }]);
      prisma.$transaction.mockResolvedValue([
        { id: 'bcast-1', channelId: 'chan-1' },
      ]);

      const result = await service.createSchedule(
        'camp-1',
        scheduleDto as never,
        user,
      );

      expect(result).toEqual([{ id: 'bcast-1', channelId: 'chan-1' }]);
    });
  });

  describe('getSchedule', () => {
    const query = { page: 1, limit: 20 } as never;

    it('should throw NotFoundException if the campaign belongs to another company', async () => {
      prisma.campaign.findFirst.mockResolvedValue(null);
      await expect(service.getSchedule('camp-1', query, user)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should return a paginated schedule scoped to the campaign', async () => {
      prisma.campaign.findFirst.mockResolvedValue(campaign);
      prisma.broadcast.findMany.mockResolvedValue([{ id: 'bcast-1' }]);
      prisma.broadcast.count.mockResolvedValue(1);

      const result = await service.getSchedule('camp-1', query, user);

      expect(prisma.broadcast.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { campaignId: 'camp-1' },
          skip: 0,
          take: 20,
        }),
      );
      expect(result).toEqual({
        items: [{ id: 'bcast-1' }],
        total: 1,
        page: 1,
        limit: 20,
        totalPages: 1,
      });
    });

    it('should apply the optional channelId/date filters', async () => {
      prisma.campaign.findFirst.mockResolvedValue(campaign);
      prisma.broadcast.findMany.mockResolvedValue([]);
      prisma.broadcast.count.mockResolvedValue(0);

      await service.getSchedule(
        'camp-1',
        {
          page: 1,
          limit: 20,
          channelId: 'chan-1',
          dateFrom: '2026-09-01T00:00:00.000Z',
          dateTo: '2026-09-30T00:00:00.000Z',
        },
        user,
      );

      expect(prisma.broadcast.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            campaignId: 'camp-1',
            channelId: 'chan-1',
            scheduledAt: {
              gte: new Date('2026-09-01T00:00:00.000Z'),
              lte: new Date('2026-09-30T00:00:00.000Z'),
            },
          },
        }),
      );
    });
  });
});
