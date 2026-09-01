import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { DiffusionsService } from './diffusions.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Role, BroadcastStatus } from '@prisma/client';

describe('DiffusionsService', () => {
  let service: DiffusionsService;
  let prisma: jest.Mocked<PrismaService>;

  const mockUser: AuthenticatedUser = {
    userId: 'user-1',
    email: 'test@test.com',
    role: Role.ADMIN,
    companyId: 'company-1',
  };

  const mockBroadcast = {
    id: 'broadcast-1',
    mediaType: 'radio',
    scheduledAt: new Date('2026-09-01T10:00:00Z'),
    actualBroadcastAt: null,
    duration: 30,
    status: BroadcastStatus.PLANNED,
    audioProof: null,
    campaignId: 'campaign-1',
    channelId: 'channel-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    campaign: {
      id: 'campaign-1',
      name: 'Test Campaign',
      launchedBy: {
        companyId: 'company-1',
      },
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DiffusionsService,
        {
          provide: PrismaService,
          useValue: {
            broadcast: {
              findUnique: jest.fn(),
              update: jest.fn(),
              findMany: jest.fn(),
            },
            campaign: {
              findUnique: jest.fn(),
            },
          },
        },
      ],
    }).compile();

    service = module.get<DiffusionsService>(DiffusionsService);
    prisma = module.get(PrismaService);
  });

  describe('updateConstat', () => {
    it('should update broadcast with actual date and audio proof', async () => {
      const dto = {
        actualBroadcastAt: '2026-09-01T10:05:00Z',
        audioProof: 'https://s3.liyanza.com/audio.mp3',
      };
      const broadcastWithCampaign = {
        ...mockBroadcast,
        campaign: {
          id: 'campaign-1',
          launchedBy: { companyId: 'company-1' },
        },
      };
      (prisma.broadcast.findUnique as jest.Mock).mockResolvedValue(
        broadcastWithCampaign,
      );
      (prisma.broadcast.update as jest.Mock).mockResolvedValue({
        ...broadcastWithCampaign,
        actualBroadcastAt: new Date(dto.actualBroadcastAt),
        audioProof: dto.audioProof,
        status: BroadcastStatus.BROADCASTED,
      });

      const result = await service.updateConstat('broadcast-1', dto, mockUser);
      expect(result.actualBroadcastAt).toEqual(new Date(dto.actualBroadcastAt));
      expect(result.audioProof).toBe(dto.audioProof);
      expect(result.status).toBe(BroadcastStatus.BROADCASTED);
    });

    it('should throw ConflictException if already constat exists', async () => {
      const broadcastWithConstat = {
        ...mockBroadcast,
        actualBroadcastAt: new Date('2026-09-01T10:05:00Z'),
        campaign: {
          id: 'campaign-1',
          launchedBy: { companyId: 'company-1' },
        },
      };
      (prisma.broadcast.findUnique as jest.Mock).mockResolvedValue(
        broadcastWithConstat,
      );

      await expect(
        service.updateConstat(
          'broadcast-1',
          { actualBroadcastAt: '2026-09-01T10:06:00Z' },
          mockUser,
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('should throw NotFoundException if broadcast not found', async () => {
      (prisma.broadcast.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(
        service.updateConstat('invalid', {}, mockUser),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException if user not in same company (assertSameCompany)', async () => {
      const otherUser = { ...mockUser, companyId: 'other-company' };
      const broadcastWithCampaign = {
        ...mockBroadcast,
        campaign: {
          id: 'campaign-1',
          launchedBy: { companyId: 'company-1' },
        },
      };
      (prisma.broadcast.findUnique as jest.Mock).mockResolvedValue(
        broadcastWithCampaign,
      );
      await expect(
        service.updateConstat('broadcast-1', {}, otherUser),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('getRapportConformite', () => {
    it('should generate rapport with correctly computed ecart for each broadcast', async () => {
      const campaign = {
        id: 'campaign-1',
        name: 'Test Campaign',
        launchedBy: { companyId: 'company-1' },
      };
      (prisma.campaign.findUnique as jest.Mock).mockResolvedValue(campaign);

      const now = new Date('2026-09-01T12:00:00Z');
      const broadcasts = [
        {
          ...mockBroadcast,
          id: 'b1',
          scheduledAt: new Date('2026-09-01T10:00:00Z'),
          actualBroadcastAt: new Date('2026-09-01T10:05:00Z'), // 5 min late
        },
        {
          ...mockBroadcast,
          id: 'b2',
          scheduledAt: new Date('2026-09-01T10:30:00Z'),
          actualBroadcastAt: new Date('2026-09-01T10:25:00Z'), // 5 min early
        },
        {
          ...mockBroadcast,
          id: 'b3',
          scheduledAt: new Date('2026-09-01T11:00:00Z'),
          actualBroadcastAt: null, // missed (past)
        },
        {
          ...mockBroadcast,
          id: 'b4',
          scheduledAt: new Date('2026-09-01T13:00:00Z'),
          actualBroadcastAt: null, // pending (future)
        },
      ];
      (prisma.broadcast.findMany as jest.Mock).mockResolvedValue(broadcasts);

      jest.useFakeTimers();
      jest.setSystemTime(now);

      const result = await service.getRapportConformite('campaign-1', mockUser);

      expect(result.campagneId).toBe('campaign-1');
      expect(result.totalDiffusions).toBe(4);
      expect(result.diffusionsDiffusees).toBe(2);
      expect(result.diffusionsManquees).toBe(1);
      expect(result.diffusionsEnAttente).toBe(1);

      expect(result.diffusions[0].ecartMinutes).toBe(5);
      expect(result.diffusions[1].ecartMinutes).toBe(-5);
      expect(result.diffusions[2].ecartMinutes).toBeNull();
      expect(result.diffusions[3].ecartMinutes).toBeNull();

      jest.useRealTimers();
    });

    it('should throw NotFoundException if campaign not found', async () => {
      (prisma.campaign.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(
        service.getRapportConformite('invalid', mockUser),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
