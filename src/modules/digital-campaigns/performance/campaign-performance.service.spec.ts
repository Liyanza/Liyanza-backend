import {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DigitalObjective, Role } from '@prisma/client';
import { CampaignPerformanceService } from './campaign-performance.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { RedisService } from '../../redis/redis.service';
import type { DigitalCampaignsService } from '../digital-campaigns.service';
import type { SocialAccountsService } from '../../social-accounts/social-accounts.service';
import type { MetaAdsClient } from '../../social-accounts/clients/meta-ads.client';
import type { LocalBenchmarksService } from './local-benchmarks.service';
import {
  MetaApiError,
  MetaTokenExpiredError,
} from '../../social-accounts/clients/meta-graph.errors';
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';

describe('CampaignPerformanceService', () => {
  const user: AuthenticatedUser = {
    userId: 'u1',
    email: 'a@b.c',
    role: Role.MARKETING_MANAGER,
    companyId: 'company-1',
  };
  const campaign = {
    id: 'camp-1',
    plannedBudget: { toNumber: () => 100000 },
    startDate: new Date('2026-10-01'),
    endDate: new Date('2026-10-11'),
  };
  const metaCampaign = {
    id: '1201',
    name: 'Promo octobre',
    status: 'ACTIVE',
    objective: 'OUTCOME_SALES',
    startTime: null,
    stopTime: null,
    adAccountId: 'act_9',
    adAccountName: 'Nexclean',
    currency: 'XAF',
  };

  let prisma: {
    digitalCampaignDetails: { findUnique: jest.Mock; update: jest.Mock };
    digitalSimulation: { findFirst: jest.Mock };
  };
  let redis: { get: jest.Mock; set: jest.Mock; del: jest.Mock };
  let socialAccounts: { getAdsAccessToken: jest.Mock };
  let metaAds: { listCampaigns: jest.Mock; getCampaignInsights: jest.Mock };
  let localBenchmarks: { record: jest.Mock };
  let service: CampaignPerformanceService;

  beforeEach(() => {
    prisma = {
      digitalCampaignDetails: { findUnique: jest.fn(), update: jest.fn() },
      digitalSimulation: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn(),
      del: jest.fn(),
    };
    socialAccounts = {
      getAdsAccessToken: jest.fn().mockResolvedValue('user-token'),
    };
    metaAds = {
      listCampaigns: jest.fn().mockResolvedValue([metaCampaign]),
      getCampaignInsights: jest
        .fn()
        .mockResolvedValue({ totals: null, daily: [] }),
    };
    localBenchmarks = { record: jest.fn().mockResolvedValue(undefined) };
    const digitalCampaigns = {
      validateDigitalCampaignAccess: jest.fn().mockResolvedValue(campaign),
    };
    service = new CampaignPerformanceService(
      prisma as unknown as PrismaService,
      redis as unknown as RedisService,
      digitalCampaigns as unknown as DigitalCampaignsService,
      socialAccounts as unknown as SocialAccountsService,
      metaAds as unknown as MetaAdsClient,
      localBenchmarks as unknown as LocalBenchmarksService,
    );
  });

  const linkedDetails = {
    id: 'd1',
    objective: DigitalObjective.SALES,
    metaCampaignId: '1201',
    metaCampaignName: 'Promo octobre',
    metaAdAccountId: 'act_9',
    metaAdCurrency: 'XAF',
    metaCampaignLinkedAt: new Date(),
  };

  it('should ask to reconnect Facebook when no ads token is stored', async () => {
    socialAccounts.getAdsAccessToken.mockResolvedValue(null);

    const error = await service
      .listMetaCampaigns('camp-1', user)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'META_ADS_NOT_CONNECTED',
    });
  });

  it('should link only a campaign returned by Meta for this account', async () => {
    prisma.digitalCampaignDetails.findUnique.mockResolvedValue({
      ...linkedDetails,
      metaCampaignId: null,
    });

    await expect(
      service.linkMetaCampaign('camp-1', '9999', user),
    ).rejects.toThrow(NotFoundException);
    expect(prisma.digitalCampaignDetails.update).not.toHaveBeenCalled();

    prisma.digitalCampaignDetails.findUnique
      .mockResolvedValueOnce({ ...linkedDetails, metaCampaignId: null })
      .mockResolvedValue(linkedDetails);
    const result = await service.linkMetaCampaign('camp-1', '1201', user);

    expect(prisma.digitalCampaignDetails.update).toHaveBeenCalledWith({
      where: { id: 'd1' },
      data: expect.objectContaining({
        metaCampaignId: '1201',
        metaAdAccountId: 'act_9',
        metaAdCurrency: 'XAF',
      }) as Record<string, unknown>,
    });
    expect(redis.del).toHaveBeenCalledWith('meta:performance:camp-1');
    expect(result).toMatchObject({ linked: true });
  });

  it('should report an unlinked campaign without calling Meta', async () => {
    prisma.digitalCampaignDetails.findUnique.mockResolvedValue({
      ...linkedDetails,
      metaCampaignId: null,
    });

    await expect(service.getPerformance('camp-1', user)).resolves.toEqual({
      linked: false,
    });
    expect(metaAds.getCampaignInsights).not.toHaveBeenCalled();
  });

  it('should serve cached insights and refresh them on demand', async () => {
    prisma.digitalCampaignDetails.findUnique.mockResolvedValue(linkedDetails);
    redis.get.mockResolvedValue(
      JSON.stringify({
        insights: { totals: null, daily: [] },
        fetchedAt: '2026-10-05T10:00:00.000Z',
      }),
    );

    const cached = await service.getPerformance('camp-1', user);
    expect(metaAds.getCampaignInsights).not.toHaveBeenCalled();
    expect(localBenchmarks.record).not.toHaveBeenCalled();
    expect(cached).toMatchObject({
      linked: true,
      fetchedAt: '2026-10-05T10:00:00.000Z',
    });

    await service.getPerformance('camp-1', user, true);
    expect(metaAds.getCampaignInsights).toHaveBeenCalledWith(
      'user-token',
      '1201',
    );
    // Résultats frais : ils alimentent les références de coûts locales.
    expect(localBenchmarks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        campaignId: 'camp-1',
        companyId: 'company-1',
        currency: 'XAF',
      }),
    );
    expect(redis.set).toHaveBeenCalledWith(
      'meta:performance:camp-1',
      expect.any(String),
      1800,
    );
  });

  it('should map Meta errors to reconnect / retry responses', async () => {
    prisma.digitalCampaignDetails.findUnique.mockResolvedValue(linkedDetails);

    metaAds.getCampaignInsights.mockRejectedValueOnce(
      new MetaTokenExpiredError('expired'),
    );
    const expired = await service
      .getPerformance('camp-1', user)
      .catch((e: unknown) => e);
    expect((expired as ConflictException).getResponse()).toMatchObject({
      code: 'META_ADS_TOKEN_EXPIRED',
    });

    metaAds.getCampaignInsights.mockRejectedValueOnce(
      new MetaApiError('(#200) Requires ads_read permission', 200),
    );
    const noPermission = await service
      .getPerformance('camp-1', user)
      .catch((e: unknown) => e);
    expect((noPermission as ConflictException).getResponse()).toMatchObject({
      code: 'META_ADS_NOT_CONNECTED',
    });

    metaAds.getCampaignInsights.mockRejectedValueOnce(
      new MetaApiError('Service temporarily unavailable', 2),
    );
    await expect(service.getPerformance('camp-1', user)).rejects.toThrow(
      ServiceUnavailableException,
    );
  });
});
