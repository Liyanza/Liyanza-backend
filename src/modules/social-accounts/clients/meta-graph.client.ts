import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';
import { SocialPlatform } from '@prisma/client';
import {
  ExchangedToken,
  PlatformInsights,
  SocialAccountProfile,
  SocialPlatformClientInterface,
} from './social-platform-client.interface';
import { MetaApiError, MetaTokenExpiredError } from './meta-graph.errors';

interface MetaTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
}

interface MetaPageEdge {
  id: string;
  name: string;
  access_token: string;
  instagram_business_account?: { id: string };
}

interface MetaErrorBody {
  error?: { message?: string; code?: number; error_subcode?: number };
}

/**
 * Implémentation réelle du client Meta Graph API (BACK-503/504). Ce n'est
 * PAS un mock — voir `.claude/skills/liyanza-ia-boundary/SKILL.md` : la
 * frontière IA porte sur les LLM/l'inférence, pas sur les API de données
 * sociales.
 *
 * Limitations documentées (V1, voir `docs/BACKLOG_REORIENTE.md` Phase 5) :
 * - Une seule Page Facebook par entreprise est prise en compte (la première
 *   renvoyée par `/me/accounts`) — pas de sélecteur multi-pages dans ce repo.
 * - CPM/CPC historiques non implémentés (nécessiteraient de conserver un
 *   token utilisateur en plus du token de Page, pour interroger
 *   `/me/adaccounts` — non fait pour limiter la surface de tokens stockés).
 * - Les noms de métriques Graph API (`page_impressions`, etc.) peuvent
 *   dériver d'une version d'API à l'autre ; à valider/ajuster une fois
 *   testé avec la vraie App Meta de l'utilisateur (je ne peux pas compléter
 *   moi-même le flow OAuth, qui exige une interaction navigateur humaine).
 */
@Injectable()
export class MetaGraphClient implements SocialPlatformClientInterface {
  private readonly logger = new Logger(MetaGraphClient.name);

  constructor(
    private readonly http: HttpService,
    private readonly configService: ConfigService,
  ) {}

  private get baseUrl(): string {
    const version =
      this.configService.get<string>('META_GRAPH_API_VERSION') ?? 'v21.0';
    return `https://graph.facebook.com/${version}`;
  }

  private get appId(): string {
    return this.configService.getOrThrow<string>('META_APP_ID');
  }

  private get appSecret(): string {
    return this.configService.getOrThrow<string>('META_APP_SECRET');
  }

  async exchangeCodeForLongLivedToken(
    _platform: SocialPlatform,
    code: string,
    redirectUri: string,
  ): Promise<ExchangedToken> {
    const shortLived = await this.graphGet<MetaTokenResponse>(
      '/oauth/access_token',
      {
        client_id: this.appId,
        client_secret: this.appSecret,
        redirect_uri: redirectUri,
        code,
      },
    );

    const longLived = await this.graphGet<MetaTokenResponse>(
      '/oauth/access_token',
      {
        grant_type: 'fb_exchange_token',
        client_id: this.appId,
        client_secret: this.appSecret,
        fb_exchange_token: shortLived.access_token,
      },
    );

    return {
      accessToken: longLived.access_token,
      expiresInSeconds: longLived.expires_in ?? null,
      // Meta ne renvoie pas la liste des scopes accordés à cet endpoint —
      // les scopes réellement demandés sont suivis côté service (state
      // OAuth), pas ici.
      scopes: [],
    };
  }

  async getAccountProfile(
    platform: SocialPlatform,
    accessToken: string,
  ): Promise<SocialAccountProfile> {
    const pages = await this.graphGet<{ data: MetaPageEdge[] }>(
      '/me/accounts',
      {
        fields: 'id,name,access_token,instagram_business_account',
        access_token: accessToken,
      },
    );

    if (platform === SocialPlatform.FACEBOOK) {
      const page = pages.data[0];
      if (!page) {
        throw new MetaApiError(
          'No Facebook Page found for this account. Create or get access to a Facebook Page first.',
        );
      }
      return {
        externalAccountId: page.id,
        externalAccountName: page.name,
        accessTokenOverride: page.access_token,
      };
    }

    // INSTAGRAM : le compte professionnel est rattaché à une Page.
    const pageWithInstagram = pages.data.find(
      (page) => page.instagram_business_account,
    );
    if (!pageWithInstagram?.instagram_business_account) {
      throw new MetaApiError(
        'No Instagram professional account linked to any managed Facebook Page.',
      );
    }

    const igAccountId = pageWithInstagram.instagram_business_account.id;
    const igProfile = await this.graphGet<{ username?: string }>(
      `/${igAccountId}`,
      { fields: 'username', access_token: pageWithInstagram.access_token },
    );

    return {
      externalAccountId: igAccountId,
      externalAccountName: igProfile.username ?? pageWithInstagram.name,
      accessTokenOverride: pageWithInstagram.access_token,
    };
  }

  async getInsights(
    platform: SocialPlatform,
    accessToken: string,
    externalAccountId: string,
  ): Promise<PlatformInsights> {
    const profileFields = await this.graphGet<{ followers_count?: number }>(
      `/${externalAccountId}`,
      { fields: 'followers_count', access_token: accessToken },
    );
    const followerCount = profileFields.followers_count;

    const metrics =
      platform === SocialPlatform.FACEBOOK
        ? 'page_impressions,page_engaged_users'
        : 'impressions,reach';

    const insights = await this.graphGet<{
      data: { name: string; values: { value: number }[] }[];
    }>(`/${externalAccountId}/insights`, {
      metric: metrics,
      period: 'days_28',
      access_token: accessToken,
    });

    const latestValue = (metricName: string): number | undefined => {
      const metric = insights.data.find((m) => m.name === metricName);
      const last = metric?.values?.at(-1);
      return last?.value;
    };

    const impressions =
      platform === SocialPlatform.FACEBOOK
        ? latestValue('page_impressions')
        : latestValue('impressions');
    const reach =
      platform === SocialPlatform.INSTAGRAM ? latestValue('reach') : undefined;
    const engagedUsers =
      platform === SocialPlatform.FACEBOOK
        ? latestValue('page_engaged_users')
        : undefined;

    // Approximation faute de métrique "taux d'engagement" directe et
    // homogène entre Facebook Pages et comptes Instagram professionnels —
    // documenté, à affiner une fois validé avec de vraies données.
    const engagementBase = engagedUsers ?? reach;
    const engagementRate =
      followerCount && followerCount > 0 && engagementBase !== undefined
        ? Math.round((engagementBase / followerCount) * 10000) / 100
        : undefined;

    return {
      followerCount,
      impressions,
      reach,
      engagementRate,
      raw: { profileFields, insights },
    };
  }

  private async graphGet<T>(
    path: string,
    params: Record<string, string>,
  ): Promise<T> {
    try {
      const response = await firstValueFrom(
        this.http.get<T>(`${this.baseUrl}${path}`, { params }),
      );
      return response.data;
    } catch (error) {
      throw this.toMetaApiError(error);
    }
  }

  private toMetaApiError(error: unknown): MetaApiError {
    if (error instanceof AxiosError) {
      const body = error.response?.data as MetaErrorBody | undefined;
      const message = body?.error?.message ?? error.message;
      const code = body?.error?.code;
      this.logger.warn(`Meta Graph API error: ${message} (code=${code})`);
      if (code === 190) {
        return new MetaTokenExpiredError(message, body);
      }
      return new MetaApiError(message, code, body);
    }
    return new MetaApiError(
      error instanceof Error ? error.message : 'Unknown Meta Graph API error',
    );
  }
}
