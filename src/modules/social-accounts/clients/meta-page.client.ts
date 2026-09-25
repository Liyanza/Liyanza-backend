import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';
import { MetaApiError, MetaTokenExpiredError } from './meta-graph.errors';

export interface DailyValue {
  date: string; // AAAA-MM-JJ
  value: number;
}

export interface RawPagePost {
  id: string;
  message?: string;
  created_time: string;
  permalink_url?: string;
  full_picture?: string;
  shares?: { count: number };
  reactions?: { summary?: { total_count?: number } };
  comments?: { summary?: { total_count?: number } };
}

export interface RawPageHealth {
  name: string;
  followers: number | null;
  /** Séries quotidiennes (56 jours) ; vide si Meta ne fournit aucune des métriques. */
  views: DailyValue[];
  engagement: DailyValue[];
  newFollowers: DailyValue[];
  posts: RawPagePost[];
}

interface MetaErrorBody {
  error?: { message?: string; code?: number };
}

/**
 * Métriques quotidiennes de la Page, de la plus récente à l'ancienne : Meta
 * en retire régulièrement (#100) — la première acceptée est utilisée.
 */
const DAILY_METRICS = {
  views: ['page_media_view', 'page_impressions'],
  engagement: ['page_post_engagements'],
  newFollowers: ['page_daily_follows_unique', 'page_fan_adds_unique'],
} as const;

export const PAGE_HEALTH_DAYS = 56;

/**
 * Lecture de la santé d'une Page Facebook avec son token de Page
 * (`pages_read_engagement`, `read_insights`) : abonnés, statistiques
 * quotidiennes, dernières publications et leurs interactions.
 */
@Injectable()
export class MetaPageClient {
  private readonly logger = new Logger(MetaPageClient.name);

  constructor(
    private readonly http: HttpService,
    private readonly configService: ConfigService,
  ) {}

  private get baseUrl(): string {
    const version =
      this.configService.get<string>('META_GRAPH_API_VERSION') ?? 'v21.0';
    return `https://graph.facebook.com/${version}`;
  }

  async getPageHealth(
    pageToken: string,
    pageId: string,
    now = new Date(),
  ): Promise<RawPageHealth> {
    const until = Math.floor(now.getTime() / 1000);
    const since = until - PAGE_HEALTH_DAYS * 86400;
    const daily = (candidates: readonly string[]) =>
      this.firstAvailableDaily(pageId, pageToken, candidates, since, until);

    const [page, views, engagement, newFollowers, posts] = await Promise.all([
      this.get<{ name?: string; followers_count?: number }>(`/${pageId}`, {
        fields: 'name,followers_count',
        access_token: pageToken,
      }),
      daily(DAILY_METRICS.views),
      daily(DAILY_METRICS.engagement),
      daily(DAILY_METRICS.newFollowers),
      this.get<{ data: RawPagePost[] }>(`/${pageId}/posts`, {
        fields:
          'id,message,created_time,permalink_url,full_picture,shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)',
        limit: '100',
        access_token: pageToken,
      }),
    ]);

    return {
      name: page.name ?? pageId,
      followers: page.followers_count ?? null,
      views,
      engagement,
      newFollowers,
      posts: posts.data,
    };
  }

  private async firstAvailableDaily(
    pageId: string,
    pageToken: string,
    candidates: readonly string[],
    since: number,
    until: number,
  ): Promise<DailyValue[]> {
    for (const metric of candidates) {
      try {
        const result = await this.get<{
          data: {
            name: string;
            values?: { value: number; end_time: string }[];
          }[];
        }>(`/${pageId}/insights`, {
          metric,
          period: 'day',
          since: String(since),
          until: String(until),
          access_token: pageToken,
        });
        const values = result.data.find((m) => m.name === metric)?.values;
        if (values) {
          return values.map((v) => ({
            // end_time = fin de la journée mesurée (minuit suivant) : le jour
            // mesuré est la veille.
            date: new Date(Date.parse(v.end_time) - 86400000)
              .toISOString()
              .slice(0, 10),
            value: typeof v.value === 'number' ? v.value : 0,
          }));
        }
      } catch (error) {
        if (!(error instanceof MetaApiError) || error.code !== 100) throw error;
      }
    }
    return [];
  }

  private async get<T>(path: string, params: Record<string, string>) {
    try {
      const response = await firstValueFrom(
        this.http.get<T>(`${this.baseUrl}${path}`, { params }),
      );
      return response.data;
    } catch (error) {
      if (error instanceof AxiosError) {
        const body = error.response?.data as MetaErrorBody | undefined;
        const message = body?.error?.message ?? error.message;
        const code = body?.error?.code;
        this.logger.warn(`Meta Page API error: ${message} (code=${code})`);
        if (code === 190) throw new MetaTokenExpiredError(message, body);
        throw new MetaApiError(message, code, body);
      }
      throw error;
    }
  }
}
