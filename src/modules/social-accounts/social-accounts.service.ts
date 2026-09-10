import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  Inject,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { QueueService } from '../queue/queue.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { SocialAccountQueryDto } from './dto/social-account-query.dto';
import { OAuthCallbackQueryDto } from './dto/oauth-callback-query.dto';
import { Prisma, SocialAccountStatus, SocialPlatform } from '@prisma/client';
import type { SocialPlatformClientInterface } from './clients/social-platform-client.interface';
import { SOCIAL_PLATFORM_CLIENT_TOKEN } from './clients/social-platform-client.interface';
import {
  encryptToken,
  decryptToken,
} from '../../common/utils/token-encryption.util';

// Jamais les colonnes de token (ciphertext/iv/tag) dans une réponse HTTP —
// même chiffrées, elles n'ont aucune raison de quitter ce service.
const SAFE_SELECT = {
  id: true,
  platform: true,
  externalAccountId: true,
  externalAccountName: true,
  status: true,
  tokenExpiresAt: true,
  lastSyncedAt: true,
  createdAt: true,
  connectedById: true,
} satisfies Prisma.SocialAccountSelect;

// 10 minutes : assez large pour une autorisation Meta manuelle (le temps
// d'un login + consentement dans une webview), assez court pour limiter la
// fenêtre d'un `state` intercepté mais jamais utilisé.
const OAUTH_STATE_TTL_SECONDS = 600;

const REQUESTED_SCOPES: Record<SocialPlatform, string[]> = {
  [SocialPlatform.FACEBOOK]: [
    'pages_show_list',
    'pages_read_engagement',
    'read_insights',
  ],
  [SocialPlatform.INSTAGRAM]: [
    'pages_show_list',
    'pages_read_engagement',
    'instagram_basic',
    'instagram_manage_insights',
  ],
};

interface OAuthStatePayload {
  userId: string;
  companyId: string;
  platform: SocialPlatform;
}

@Injectable()
export class SocialAccountsService {
  private readonly logger = new Logger(SocialAccountsService.name);

  constructor(
    private prisma: PrismaService,
    private redisService: RedisService,
    private queueService: QueueService,
    private configService: ConfigService,
    @Inject(SOCIAL_PLATFORM_CLIENT_TOKEN)
    private platformClient: SocialPlatformClientInterface,
  ) {}

  async findAll(user: AuthenticatedUser, query: SocialAccountQueryDto) {
    if (!user.companyId) {
      throw new ForbiddenException(
        'You must belong to a company to view linked social accounts.',
      );
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const skip = (page - 1) * limit;
    const where: Prisma.SocialAccountWhereInput = {
      companyId: user.companyId,
    };
    if (query.platform) {
      where.platform = query.platform;
    }

    const [items, total] = await Promise.all([
      this.prisma.socialAccount.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: SAFE_SELECT,
      }),
      this.prisma.socialAccount.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Démarre le flow OAuth : génère un `state` imprévisible, l'enregistre
   * dans Redis avec le contexte réel (userId/companyId/platform) et renvoie
   * l'URL d'autorisation Meta. Le `state` est la SEULE façon dont le
   * callback public (`handleOAuthCallback`) retrouve ce contexte — jamais
   * depuis un champ fourni par l'appelant du callback.
   */
  async startOAuth(platformParam: string, user: AuthenticatedUser) {
    if (!user.companyId) {
      throw new ForbiddenException(
        'You must belong to a company to link a social account.',
      );
    }
    const platform = this.parsePlatform(platformParam);

    const state = randomBytes(24).toString('base64url');
    const payload: OAuthStatePayload = {
      userId: user.userId,
      companyId: user.companyId,
      platform,
    };
    await this.redisService.set(
      this.stateKey(state),
      JSON.stringify(payload),
      OAUTH_STATE_TTL_SECONDS,
    );

    const appId = this.configService.getOrThrow<string>('META_APP_ID');
    const redirectUri = this.configService.getOrThrow<string>(
      'META_OAUTH_REDIRECT_URI',
    );
    const version =
      this.configService.get<string>('META_GRAPH_API_VERSION') ?? 'v21.0';

    const url = new URL(`https://www.facebook.com/${version}/dialog/oauth`);
    url.searchParams.set('client_id', appId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('scope', REQUESTED_SCOPES[platform].join(','));
    url.searchParams.set('response_type', 'code');

    return { authorizationUrl: url.toString() };
  }

  /**
   * Callback public appelé directement par le navigateur/webview de
   * l'utilisateur après consentement (ou refus) côté Meta — jamais de JWT
   * ici. Toute décision de sécurité (à quelle entreprise/utilisateur
   * rattacher le compte) provient exclusivement du `state` consommé de
   * façon atomique dans Redis, jamais de la query string elle-même.
   */
  async handleOAuthCallback(query: OAuthCallbackQueryDto) {
    const mobileRedirectBase = this.configService.getOrThrow<string>(
      'SOCIAL_OAUTH_MOBILE_REDIRECT_URL',
    );

    if (query.error) {
      this.logger.warn(
        `Meta OAuth denied/error: ${query.error} — ${query.error_description ?? ''}`,
      );
      return {
        redirectUrl: this.buildResultUrl(mobileRedirectBase, 'error', {
          reason: 'denied',
        }),
      };
    }

    // Consommation atomique — au plus un appelant concurrent (rejeu du
    // callback, double redirection navigateur) obtient un `state` valide.
    const rawState = await this.redisService.getDel(this.stateKey(query.state));
    if (!rawState) {
      return {
        redirectUrl: this.buildResultUrl(mobileRedirectBase, 'error', {
          reason: 'invalid_or_expired_state',
        }),
      };
    }

    let statePayload: OAuthStatePayload;
    try {
      statePayload = JSON.parse(rawState) as OAuthStatePayload;
    } catch {
      return {
        redirectUrl: this.buildResultUrl(mobileRedirectBase, 'error', {
          reason: 'invalid_state_payload',
        }),
      };
    }

    if (!query.code) {
      return {
        redirectUrl: this.buildResultUrl(mobileRedirectBase, 'error', {
          reason: 'missing_code',
          platform: statePayload.platform,
        }),
      };
    }

    try {
      const redirectUri = this.configService.getOrThrow<string>(
        'META_OAUTH_REDIRECT_URI',
      );
      const token = await this.platformClient.exchangeCodeForLongLivedToken(
        statePayload.platform,
        query.code,
        redirectUri,
      );
      const profile = await this.platformClient.getAccountProfile(
        statePayload.platform,
        token.accessToken,
      );
      const tokenToStore = profile.accessTokenOverride ?? token.accessToken;
      const encryptionKey = this.configService.getOrThrow<string>(
        'SOCIAL_TOKEN_ENCRYPTION_KEY',
      );
      const encrypted = encryptToken(tokenToStore, encryptionKey);
      const tokenExpiresAt = token.expiresInSeconds
        ? new Date(Date.now() + token.expiresInSeconds * 1000)
        : null;

      const socialAccount = await this.prisma.socialAccount.upsert({
        where: {
          companyId_platform_externalAccountId: {
            companyId: statePayload.companyId,
            platform: statePayload.platform,
            externalAccountId: profile.externalAccountId,
          },
        },
        create: {
          platform: statePayload.platform,
          externalAccountId: profile.externalAccountId,
          externalAccountName: profile.externalAccountName,
          accessTokenCiphertext: encrypted.ciphertext,
          accessTokenIv: encrypted.iv,
          accessTokenTag: encrypted.tag,
          tokenExpiresAt,
          scopes: REQUESTED_SCOPES[statePayload.platform],
          status: SocialAccountStatus.ACTIVE,
          companyId: statePayload.companyId,
          connectedById: statePayload.userId,
        },
        update: {
          externalAccountName: profile.externalAccountName,
          accessTokenCiphertext: encrypted.ciphertext,
          accessTokenIv: encrypted.iv,
          accessTokenTag: encrypted.tag,
          tokenExpiresAt,
          status: SocialAccountStatus.ACTIVE,
          connectedById: statePayload.userId,
          // Reconnexion : un futur cycle d'expiration doit pouvoir renotifier.
          expiryReminderSentAt: null,
        },
      });

      await this.queueService.addJob('social-metrics-sync', 'sync', {
        socialAccountId: socialAccount.id,
      });

      return {
        redirectUrl: this.buildResultUrl(mobileRedirectBase, 'success', {
          platform: statePayload.platform,
        }),
      };
    } catch (error) {
      this.logger.error(
        `Meta OAuth callback failed for company ${statePayload.companyId}`,
        error instanceof Error ? error.stack : String(error),
      );
      return {
        redirectUrl: this.buildResultUrl(mobileRedirectBase, 'error', {
          reason: 'exchange_failed',
          platform: statePayload.platform,
        }),
      };
    }
  }

  /**
   * Déconnecte un compte social. Ne fait jamais de suppression physique :
   * `PlatformMetric` référence `socialAccountId` en FK non-nullable
   * (`onDelete: Restrict`), et conserver l'historique de métriques déjà
   * ingérées a de la valeur même après déconnexion. Verrou optimiste sur le
   * `status`, même pattern que toute transition d'état concurrente dans ce
   * repo.
   */
  async revoke(id: string, user: AuthenticatedUser) {
    if (!user.companyId) {
      throw new ForbiddenException(
        'You must belong to a company to manage linked social accounts.',
      );
    }

    const account = await this.prisma.socialAccount.findFirst({
      where: { id, companyId: user.companyId },
    });
    if (!account) {
      throw new NotFoundException('Social account not found.');
    }

    const result = await this.prisma.socialAccount.updateMany({
      where: {
        id,
        companyId: user.companyId,
        status: { not: SocialAccountStatus.REVOKED },
      },
      data: { status: SocialAccountStatus.REVOKED },
    });
    if (result.count === 0) {
      throw new ConflictException('This social account is already revoked.');
    }

    return { success: true };
  }

  /** Re-synchronisation manuelle — enfile un job, ne bloque jamais la requête. */
  async triggerSync(id: string, user: AuthenticatedUser) {
    if (!user.companyId) {
      throw new ForbiddenException(
        'You must belong to a company to manage linked social accounts.',
      );
    }

    const account = await this.prisma.socialAccount.findFirst({
      where: { id, companyId: user.companyId },
    });
    if (!account) {
      throw new NotFoundException('Social account not found.');
    }
    if (account.status !== SocialAccountStatus.ACTIVE) {
      throw new BadRequestException(
        'Reconnect this social account before syncing (it is not ACTIVE).',
      );
    }

    await this.queueService.addJob('social-metrics-sync', 'sync', {
      socialAccountId: account.id,
    });

    return { success: true };
  }

  /**
   * Déchiffre le token d'un compte — utilisé exclusivement par le worker de
   * synchronisation (`SocialMetricsSyncProcessor`), jamais exposé via un
   * endpoint HTTP.
   */
  decryptAccessToken(account: {
    accessTokenCiphertext: string;
    accessTokenIv: string;
    accessTokenTag: string;
  }): string {
    const encryptionKey = this.configService.getOrThrow<string>(
      'SOCIAL_TOKEN_ENCRYPTION_KEY',
    );
    return decryptToken(
      {
        ciphertext: account.accessTokenCiphertext,
        iv: account.accessTokenIv,
        tag: account.accessTokenTag,
      },
      encryptionKey,
    );
  }

  // ---------- Private helpers ----------

  private stateKey(state: string): string {
    return `oauth:meta:state:${state}`;
  }

  private parsePlatform(value: string): SocialPlatform {
    const normalized = value.toUpperCase();
    if (!Object.values(SocialPlatform).includes(normalized as SocialPlatform)) {
      throw new BadRequestException(`Unsupported platform: ${value}`);
    }
    return normalized as SocialPlatform;
  }

  private buildResultUrl(
    base: string,
    status: 'success' | 'error',
    params: Record<string, string | undefined>,
  ): string {
    const url = new URL(base);
    url.searchParams.set('status', status);
    for (const [key, value] of Object.entries(params)) {
      if (value) url.searchParams.set(key, value);
    }
    return url.toString();
  }
}
