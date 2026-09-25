import {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { PageHealthService } from './page-health.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { RedisService } from '../../redis/redis.service';
import type { SocialAccountsService } from '../social-accounts.service';
import type { MetaPageClient } from '../clients/meta-page.client';
import type { PageHealthAnalysisClient } from '../clients/page-health-analysis.client';
import { MetaTokenExpiredError } from '../clients/meta-graph.errors';
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';

describe('PageHealthService', () => {
  const user: AuthenticatedUser = {
    userId: 'u1',
    email: 'a@b.c',
    role: Role.COMMUNITY_MANAGER,
    companyId: 'company-1',
  };
  const account = {
    id: 'sa-1',
    platform: 'FACEBOOK',
    status: 'ACTIVE',
    externalAccountId: 'page-1',
    accessTokenCiphertext: 'x',
    accessTokenIv: 'y',
    accessTokenTag: 'z',
  };
  const rawHealth = {
    name: 'Nexclean',
    followers: 1000,
    views: [],
    engagement: [],
    newFollowers: [],
    posts: [],
  };

  let prisma: { socialAccount: { findFirst: jest.Mock } };
  let redis: { get: jest.Mock; set: jest.Mock };
  let metaPage: { getPageHealth: jest.Mock };
  let analysisClient: { analyze: jest.Mock };
  let service: PageHealthService;

  beforeEach(() => {
    prisma = {
      socialAccount: { findFirst: jest.fn().mockResolvedValue(account) },
    };
    redis = { get: jest.fn().mockResolvedValue(null), set: jest.fn() };
    metaPage = { getPageHealth: jest.fn().mockResolvedValue(rawHealth) };
    analysisClient = { analyze: jest.fn() };
    service = new PageHealthService(
      prisma as unknown as PrismaService,
      redis as unknown as RedisService,
      {
        decryptAccessToken: jest.fn().mockReturnValue('page-token'),
      } as unknown as SocialAccountsService,
      metaPage as unknown as MetaPageClient,
      analysisClient as unknown as PageHealthAnalysisClient,
    );
  });

  it('should read the Page with its token, scoped to the company, and cache it 1 h', async () => {
    const result = await service.getHealth('sa-1', user);

    expect(prisma.socialAccount.findFirst).toHaveBeenCalledWith({
      where: { id: 'sa-1', companyId: 'company-1', platform: 'FACEBOOK' },
    });
    expect(metaPage.getPageHealth).toHaveBeenCalledWith('page-token', 'page-1');
    expect(redis.set).toHaveBeenCalledWith(
      'page-health:data:sa-1',
      expect.any(String),
      3600,
    );
    expect(result).toMatchObject({
      health: { pageName: 'Nexclean', followers: 1000 },
      analysis: null,
    });
  });

  it('should serve cached data and the stored AI summary', async () => {
    redis.get.mockImplementation((key: string) =>
      Promise.resolve(
        key === 'page-health:data:sa-1'
          ? JSON.stringify({
              raw: rawHealth,
              fetchedAt: '2026-09-26T08:00:00Z',
            })
          : JSON.stringify({
              analysis: { summary: 'Résumé' },
              generatedAt: 'x',
            }),
      ),
    );

    const result = await service.getHealth('sa-1', user);

    expect(metaPage.getPageHealth).not.toHaveBeenCalled();
    expect(result.analysis).toMatchObject({ analysis: { summary: 'Résumé' } });
  });

  it('should ask to reconnect an expired Page and 404 another company', async () => {
    prisma.socialAccount.findFirst.mockResolvedValueOnce(null);
    await expect(service.getHealth('sa-x', user)).rejects.toThrow(
      NotFoundException,
    );

    metaPage.getPageHealth.mockRejectedValueOnce(
      new MetaTokenExpiredError('expired'),
    );
    const error = await service
      .getHealth('sa-1', user)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'PAGE_RECONNECT_REQUIRED',
    });
  });

  it('should store the AI summary 7 days, and 503 when the AI fails', async () => {
    analysisClient.analyze.mockResolvedValueOnce({
      summary: 'Résumé',
      strengths: [],
      watchouts: [],
      actions: [],
    });

    const result = await service.analyze('sa-1', user);

    expect(analysisClient.analyze).toHaveBeenCalledWith(
      expect.objectContaining({ pageName: 'Nexclean', followers: 1000 }),
    );
    expect(result.analysis.summary).toBe('Résumé');
    expect(redis.set).toHaveBeenCalledWith(
      'page-health:analysis:sa-1',
      expect.any(String),
      604800,
    );

    analysisClient.analyze.mockRejectedValueOnce(new Error('timeout'));
    await expect(service.analyze('sa-1', user)).rejects.toThrow(
      ServiceUnavailableException,
    );
  });
});
