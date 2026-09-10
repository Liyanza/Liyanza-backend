import { Test, TestingModule } from '@nestjs/testing';
import { Job } from 'bullmq';
import { SocialMetricsSyncProcessor } from './social-metrics-sync.processor';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { SocialAccountsService } from '../social-accounts.service';
import { SOCIAL_PLATFORM_CLIENT_TOKEN } from '../clients/social-platform-client.interface';
import { MetaTokenExpiredError } from '../clients/meta-graph.errors';
import {
  MetricPeriod,
  SocialAccountStatus,
  SocialPlatform,
} from '@prisma/client';

describe('SocialMetricsSyncProcessor', () => {
  let processor: SocialMetricsSyncProcessor;
  let prisma: {
    socialAccount: {
      findUnique: jest.Mock;
      updateMany: jest.Mock;
      update: jest.Mock;
    };
    platformMetric: { create: jest.Mock };
    $transaction: jest.Mock;
  };
  let notificationsService: { creer: jest.Mock };
  let socialAccountsService: { decryptAccessToken: jest.Mock };
  let platformClient: { getInsights: jest.Mock };

  const activeAccount = {
    id: 'sa-1',
    platform: SocialPlatform.FACEBOOK,
    externalAccountId: 'page-1',
    externalAccountName: 'My Page',
    connectedById: 'user-1',
    status: SocialAccountStatus.ACTIVE,
    accessTokenCiphertext: 'c',
    accessTokenIv: 'i',
    accessTokenTag: 't',
  };

  beforeEach(async () => {
    notificationsService = { creer: jest.fn() };
    socialAccountsService = {
      decryptAccessToken: jest.fn().mockReturnValue('decrypted-token'),
    };
    platformClient = { getInsights: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SocialMetricsSyncProcessor,
        {
          provide: PrismaService,
          useValue: {
            socialAccount: {
              findUnique: jest.fn(),
              updateMany: jest.fn(),
              update: jest.fn(),
            },
            platformMetric: { create: jest.fn() },
            $transaction: jest.fn((ops: unknown) =>
              Promise.all(ops as Promise<unknown>[]),
            ),
          },
        },
        { provide: NotificationsService, useValue: notificationsService },
        { provide: SocialAccountsService, useValue: socialAccountsService },
        { provide: SOCIAL_PLATFORM_CLIENT_TOKEN, useValue: platformClient },
      ],
    }).compile();

    processor = module.get(SocialMetricsSyncProcessor);
    prisma = module.get(PrismaService);
  });

  const buildJob = (data: { socialAccountId: string }, name = 'sync') =>
    ({ name, data }) as Job<{ socialAccountId: string }>;

  it('should ignore jobs with an unknown name', async () => {
    await processor.process(buildJob({ socialAccountId: 'sa-1' }, 'other'));
    expect(prisma.socialAccount.findUnique).not.toHaveBeenCalled();
  });

  it('should discard the job if the social account no longer exists', async () => {
    prisma.socialAccount.findUnique.mockResolvedValue(null);

    await processor.process(buildJob({ socialAccountId: 'sa-1' }));

    expect(platformClient.getInsights).not.toHaveBeenCalled();
  });

  it('should skip a non-ACTIVE account without error', async () => {
    prisma.socialAccount.findUnique.mockResolvedValue({
      ...activeAccount,
      status: SocialAccountStatus.REVOKED,
    });

    await processor.process(buildJob({ socialAccountId: 'sa-1' }));

    expect(platformClient.getInsights).not.toHaveBeenCalled();
  });

  it('should persist a PlatformMetric and update lastSyncedAt on success', async () => {
    prisma.socialAccount.findUnique.mockResolvedValue(activeAccount);
    platformClient.getInsights.mockResolvedValue({
      followerCount: 1000,
      impressions: 500,
      reach: 400,
      engagementRate: 12.5,
      raw: { ok: true },
    });
    prisma.platformMetric.create.mockResolvedValue({ id: 'metric-1' });
    prisma.socialAccount.update.mockResolvedValue({ id: 'sa-1' });

    await processor.process(buildJob({ socialAccountId: 'sa-1' }));

    expect(socialAccountsService.decryptAccessToken).toHaveBeenCalledWith(
      activeAccount,
    );
    expect(platformClient.getInsights).toHaveBeenCalledWith(
      SocialPlatform.FACEBOOK,
      'decrypted-token',
      'page-1',
    );
    expect(prisma.platformMetric.create).toHaveBeenCalledWith({
      data: {
        socialAccountId: 'sa-1',
        followerCount: 1000,
        impressions: 500,
        reach: 400,
        engagementRate: 12.5,
        avgCpm: undefined,
        avgCpc: undefined,
        period: MetricPeriod.DAY_28,
        rawPayload: { ok: true },
      },
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('should mark the account EXPIRED and notify the connecting user on a token-expired error', async () => {
    prisma.socialAccount.findUnique.mockResolvedValue(activeAccount);
    platformClient.getInsights.mockRejectedValue(
      new MetaTokenExpiredError('Session expired'),
    );
    prisma.socialAccount.updateMany.mockResolvedValue({ count: 1 });

    await processor.process(buildJob({ socialAccountId: 'sa-1' }));

    expect(prisma.socialAccount.updateMany).toHaveBeenCalledWith({
      where: { id: 'sa-1', status: SocialAccountStatus.ACTIVE },
      data: { status: SocialAccountStatus.EXPIRED },
    });
    expect(notificationsService.creer).toHaveBeenCalledWith(
      expect.objectContaining({ recipientId: 'user-1' }),
    );
  });

  it('should not double-notify if the account was already marked EXPIRED concurrently', async () => {
    prisma.socialAccount.findUnique.mockResolvedValue(activeAccount);
    platformClient.getInsights.mockRejectedValue(
      new MetaTokenExpiredError('Session expired'),
    );
    prisma.socialAccount.updateMany.mockResolvedValue({ count: 0 });

    await processor.process(buildJob({ socialAccountId: 'sa-1' }));

    expect(notificationsService.creer).not.toHaveBeenCalled();
  });

  it('should rethrow any other error so BullMQ can retry', async () => {
    prisma.socialAccount.findUnique.mockResolvedValue(activeAccount);
    platformClient.getInsights.mockRejectedValue(new Error('network blip'));

    await expect(
      processor.process(buildJob({ socialAccountId: 'sa-1' })),
    ).rejects.toThrow('network blip');
    expect(prisma.socialAccount.updateMany).not.toHaveBeenCalled();
  });
});
