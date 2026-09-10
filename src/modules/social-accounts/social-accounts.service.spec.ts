import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { SocialAccountsService } from './social-accounts.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { QueueService } from '../queue/queue.service';
import { ConfigService } from '@nestjs/config';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Role, SocialAccountStatus, SocialPlatform } from '@prisma/client';
import { SOCIAL_PLATFORM_CLIENT_TOKEN } from './clients/social-platform-client.interface';
import { decryptToken } from '../../common/utils/token-encryption.util';

/**
 * `prisma.socialAccount.upsert` est un `jest.Mock` non générique (comme
 * partout ailleurs dans ce fichier) : indexer `.mock.calls[n][0]`
 * directement donnerait un `any`, ce que le lint interdit
 * (`no-unsafe-member-access`). On type le mock une seule fois ici plutôt que
 * de répéter un `as` à chaque site d'appel.
 */
interface UpsertArgsForTest {
  where: unknown;
  create: {
    companyId: string;
    connectedById: string;
    accessTokenCiphertext: string;
    accessTokenIv: string;
    accessTokenTag: string;
  };
}
function getUpsertArgs(mock: jest.Mock, callIndex: number): UpsertArgsForTest {
  const typedMock = mock as jest.Mock<unknown, [UpsertArgsForTest]>;
  return typedMock.mock.calls[callIndex][0];
}

describe('SocialAccountsService', () => {
  let service: SocialAccountsService;
  let prisma: {
    socialAccount: {
      findMany: jest.Mock;
      count: jest.Mock;
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      updateMany: jest.Mock;
      upsert: jest.Mock;
    };
  };
  let redisService: { set: jest.Mock; getDel: jest.Mock };
  let queueService: { addJob: jest.Mock };
  let platformClient: {
    exchangeCodeForLongLivedToken: jest.Mock;
    getAccountProfile: jest.Mock;
    getInsights: jest.Mock;
  };

  const ENCRYPTION_KEY = randomBytes(32).toString('base64');
  const CONFIG_VALUES: Record<string, string> = {
    META_APP_ID: 'app-id',
    META_OAUTH_REDIRECT_URI: 'https://api.test/social-accounts/oauth/callback',
    META_GRAPH_API_VERSION: 'v21.0',
    SOCIAL_TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
    SOCIAL_OAUTH_MOBILE_REDIRECT_URL: 'https://mobile.test/oauth/result',
  };

  const user: AuthenticatedUser = {
    userId: 'user-1',
    email: 'admin@test.com',
    role: Role.ADMIN,
    companyId: 'company-1',
  };

  beforeEach(async () => {
    redisService = { set: jest.fn(), getDel: jest.fn() };
    queueService = { addJob: jest.fn() };
    platformClient = {
      exchangeCodeForLongLivedToken: jest.fn(),
      getAccountProfile: jest.fn(),
      getInsights: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SocialAccountsService,
        {
          provide: PrismaService,
          useValue: {
            socialAccount: {
              findMany: jest.fn(),
              count: jest.fn(),
              findFirst: jest.fn(),
              findUnique: jest.fn(),
              updateMany: jest.fn(),
              upsert: jest.fn(),
            },
          },
        },
        { provide: RedisService, useValue: redisService },
        { provide: QueueService, useValue: queueService },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => CONFIG_VALUES[key]),
            getOrThrow: jest.fn((key: string) => {
              const value = CONFIG_VALUES[key];
              if (value === undefined) {
                throw new Error(`Missing config: ${key}`);
              }
              return value;
            }),
          },
        },
        { provide: SOCIAL_PLATFORM_CLIENT_TOKEN, useValue: platformClient },
      ],
    }).compile();

    service = module.get<SocialAccountsService>(SocialAccountsService);
    prisma = module.get(PrismaService);
  });

  describe('findAll', () => {
    it('should throw ForbiddenException if the user has no company', async () => {
      await expect(
        service.findAll({ ...user, companyId: null }, {}),
      ).rejects.toThrow(ForbiddenException);
    });

    // Sélection explicite (pas `objectContaining`) : une égalité stricte
    // détecte aussi bien l'oubli d'un filtre que l'ajout accidentel d'une
    // colonne de token dans `select` (accessTokenCiphertext/Iv/Tag) — ces
    // colonnes ne doivent JAMAIS quitter ce service, même chiffrées.
    it('should scope the query to the user company and never select token columns', async () => {
      prisma.socialAccount.findMany.mockResolvedValue([]);
      prisma.socialAccount.count.mockResolvedValue(0);

      await service.findAll(user, {});

      expect(prisma.socialAccount.findMany).toHaveBeenCalledWith({
        where: { companyId: 'company-1' },
        skip: 0,
        take: 10,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          platform: true,
          externalAccountId: true,
          externalAccountName: true,
          status: true,
          tokenExpiresAt: true,
          lastSyncedAt: true,
          createdAt: true,
          connectedById: true,
        },
      });
    });

    it('should filter by platform when provided', async () => {
      prisma.socialAccount.findMany.mockResolvedValue([]);
      prisma.socialAccount.count.mockResolvedValue(0);

      await service.findAll(user, { platform: SocialPlatform.INSTAGRAM });

      expect(prisma.socialAccount.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            companyId: 'company-1',
            platform: SocialPlatform.INSTAGRAM,
          },
        }),
      );
    });
  });

  describe('startOAuth', () => {
    it('should throw ForbiddenException if the user has no company', async () => {
      await expect(
        service.startOAuth('facebook', { ...user, companyId: null }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should reject an unsupported platform', async () => {
      await expect(service.startOAuth('tiktok', user)).rejects.toThrow(
        BadRequestException,
      );
      expect(redisService.set).not.toHaveBeenCalled();
    });

    it('should store the real context in Redis and return a Meta authorization URL', async () => {
      const result = await service.startOAuth('facebook', user);

      expect(redisService.set).toHaveBeenCalledTimes(1);
      const [key, value, ttl] = redisService.set.mock.calls[0] as [
        string,
        string,
        number,
      ];
      expect(key).toMatch(/^oauth:meta:state:/);
      expect(JSON.parse(value)).toEqual({
        userId: 'user-1',
        companyId: 'company-1',
        platform: SocialPlatform.FACEBOOK,
      });
      expect(ttl).toBe(600);

      const url = new URL(result.authorizationUrl);
      expect(url.hostname).toBe('www.facebook.com');
      expect(url.searchParams.get('client_id')).toBe('app-id');
      expect(url.searchParams.get('redirect_uri')).toBe(
        'https://api.test/social-accounts/oauth/callback',
      );
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('state')).toBeTruthy();
    });
  });

  describe('handleOAuthCallback', () => {
    it('should redirect with an error status when Meta reports denial, without touching Redis state', async () => {
      const result = await service.handleOAuthCallback({
        state: 'irrelevant',
        error: 'access_denied',
        error_description: 'User denied',
      });

      expect(redisService.getDel).not.toHaveBeenCalled();
      const url = new URL(result.redirectUrl);
      expect(url.searchParams.get('status')).toBe('error');
      expect(url.searchParams.get('reason')).toBe('denied');
    });

    it('should redirect with an error status when the state is invalid or already consumed', async () => {
      redisService.getDel.mockResolvedValue(null);

      const result = await service.handleOAuthCallback({
        code: 'auth-code',
        state: 'replayed-or-unknown',
      });

      const url = new URL(result.redirectUrl);
      expect(url.searchParams.get('status')).toBe('error');
      expect(url.searchParams.get('reason')).toBe('invalid_or_expired_state');
      expect(prisma.socialAccount.upsert).not.toHaveBeenCalled();
    });

    // RÉGRESSION (garde-fou #1/#2) : companyId/userId proviennent
    // EXCLUSIVEMENT du `state` consommé dans Redis, jamais de la query
    // string du callback public — un attaquant contrôle entièrement cette
    // query string.
    it('should persist the social account scoped to the company/user recovered from Redis state, not from query params', async () => {
      redisService.getDel.mockResolvedValue(
        JSON.stringify({
          userId: 'user-from-state',
          companyId: 'company-from-state',
          platform: SocialPlatform.FACEBOOK,
        }),
      );
      platformClient.exchangeCodeForLongLivedToken.mockResolvedValue({
        accessToken: 'user-token',
        expiresInSeconds: 5_184_000,
        scopes: [],
      });
      platformClient.getAccountProfile.mockResolvedValue({
        externalAccountId: 'page-1',
        externalAccountName: 'My Page',
        accessTokenOverride: 'page-token',
      });
      prisma.socialAccount.upsert.mockResolvedValue({ id: 'sa-1' });

      await service.handleOAuthCallback({
        code: 'auth-code',
        state: 'state-abc',
      });

      expect(redisService.getDel).toHaveBeenCalledWith(
        'oauth:meta:state:state-abc',
      );
      expect(prisma.socialAccount.upsert).toHaveBeenCalledTimes(1);
      const args = getUpsertArgs(prisma.socialAccount.upsert, 0);

      expect(args.where).toEqual({
        companyId_platform_externalAccountId: {
          companyId: 'company-from-state',
          platform: SocialPlatform.FACEBOOK,
          externalAccountId: 'page-1',
        },
      });
      expect(args.create.companyId).toBe('company-from-state');
      expect(args.create.connectedById).toBe('user-from-state');
      // Le token de PAGE (accessTokenOverride) est celui persisté, pas le
      // token utilisateur retourné par l'échange initial.
      const decrypted = decryptToken(
        {
          ciphertext: args.create.accessTokenCiphertext,
          iv: args.create.accessTokenIv,
          tag: args.create.accessTokenTag,
        },
        ENCRYPTION_KEY,
      );
      expect(decrypted).toBe('page-token');

      expect(queueService.addJob).toHaveBeenCalledWith(
        'social-metrics-sync',
        'sync',
        { socialAccountId: 'sa-1' },
      );
    });

    it('should redirect with an error status if the token exchange fails', async () => {
      redisService.getDel.mockResolvedValue(
        JSON.stringify({
          userId: 'user-1',
          companyId: 'company-1',
          platform: SocialPlatform.FACEBOOK,
        }),
      );
      platformClient.exchangeCodeForLongLivedToken.mockRejectedValue(
        new Error('Meta is down'),
      );

      const result = await service.handleOAuthCallback({
        code: 'auth-code',
        state: 'state-abc',
      });

      const url = new URL(result.redirectUrl);
      expect(url.searchParams.get('status')).toBe('error');
      expect(url.searchParams.get('reason')).toBe('exchange_failed');
      expect(prisma.socialAccount.upsert).not.toHaveBeenCalled();
    });
  });

  describe('revoke', () => {
    it('should throw NotFoundException on cross-tenant access', async () => {
      prisma.socialAccount.findFirst.mockResolvedValue(null);

      await expect(service.revoke('sa-1', user)).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.socialAccount.updateMany).not.toHaveBeenCalled();
    });

    it('should throw ConflictException when already revoked concurrently', async () => {
      prisma.socialAccount.findFirst.mockResolvedValue({
        id: 'sa-1',
        companyId: 'company-1',
        status: SocialAccountStatus.ACTIVE,
      });
      prisma.socialAccount.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.revoke('sa-1', user)).rejects.toThrow(
        ConflictException,
      );
    });

    it('should reaffirm companyId in the write clause, not just the read', async () => {
      prisma.socialAccount.findFirst.mockResolvedValue({
        id: 'sa-1',
        companyId: 'company-1',
        status: SocialAccountStatus.ACTIVE,
      });
      prisma.socialAccount.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.revoke('sa-1', user);

      expect(prisma.socialAccount.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'sa-1',
          companyId: 'company-1',
          status: { not: SocialAccountStatus.REVOKED },
        },
        data: { status: SocialAccountStatus.REVOKED },
      });
      expect(result).toEqual({ success: true });
    });
  });

  describe('triggerSync', () => {
    it('should throw NotFoundException on cross-tenant access', async () => {
      prisma.socialAccount.findFirst.mockResolvedValue(null);

      await expect(service.triggerSync('sa-1', user)).rejects.toThrow(
        NotFoundException,
      );
      expect(queueService.addJob).not.toHaveBeenCalled();
    });

    it('should reject syncing a non-ACTIVE account', async () => {
      prisma.socialAccount.findFirst.mockResolvedValue({
        id: 'sa-1',
        companyId: 'company-1',
        status: SocialAccountStatus.EXPIRED,
      });

      await expect(service.triggerSync('sa-1', user)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should enqueue a sync job for an ACTIVE account', async () => {
      prisma.socialAccount.findFirst.mockResolvedValue({
        id: 'sa-1',
        companyId: 'company-1',
        status: SocialAccountStatus.ACTIVE,
      });

      const result = await service.triggerSync('sa-1', user);

      expect(queueService.addJob).toHaveBeenCalledWith(
        'social-metrics-sync',
        'sync',
        { socialAccountId: 'sa-1' },
      );
      expect(result).toEqual({ success: true });
    });
  });

  describe('decryptAccessToken', () => {
    it('should decrypt a token encrypted with the configured key', async () => {
      // Chiffre via un premier aller-retour OAuth réussi, puis vérifie que
      // `decryptAccessToken` (utilisé par le worker de sync) retrouve le
      // même texte en clair à partir des colonnes persistées.
      redisService.getDel.mockResolvedValue(
        JSON.stringify({
          userId: 'user-1',
          companyId: 'company-1',
          platform: SocialPlatform.FACEBOOK,
        }),
      );
      platformClient.exchangeCodeForLongLivedToken.mockResolvedValue({
        accessToken: 'user-token',
        expiresInSeconds: null,
        scopes: [],
      });
      platformClient.getAccountProfile.mockResolvedValue({
        externalAccountId: 'page-1',
        externalAccountName: 'My Page',
        accessTokenOverride: 'page-token-to-roundtrip',
      });
      prisma.socialAccount.upsert.mockResolvedValue({ id: 'sa-1' });

      await service.handleOAuthCallback({ code: 'c', state: 's' });

      const args = getUpsertArgs(prisma.socialAccount.upsert, 0);

      const decrypted = service.decryptAccessToken({
        accessTokenCiphertext: args.create.accessTokenCiphertext,
        accessTokenIv: args.create.accessTokenIv,
        accessTokenTag: args.create.accessTokenTag,
      });

      expect(decrypted).toBe('page-token-to-roundtrip');
    });
  });
});
