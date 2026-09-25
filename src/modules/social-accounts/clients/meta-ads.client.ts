import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';
import { MetaApiError, MetaTokenExpiredError } from './meta-graph.errors';

/** Campagne Facebook Ads d'un compte publicitaire accessible à l'utilisateur. */
export interface MetaAdCampaign {
  id: string;
  name: string;
  status: string;
  objective: string | null;
  startTime: string | null;
  stopTime: string | null;
  adAccountId: string;
  adAccountName: string;
  currency: string;
}

/** Action Meta (`actions` / `action_values` des insights). */
export interface MetaAction {
  action_type: string;
  value: string;
}

/** Totaux ou point quotidien des insights d'une campagne (valeurs Meta brutes). */
export interface MetaInsightsRow {
  date_start: string;
  date_stop: string;
  spend?: string;
  reach?: string;
  impressions?: string;
  clicks?: string;
  inline_link_clicks?: string;
  frequency?: string;
  actions?: MetaAction[];
  action_values?: MetaAction[];
}

export interface MetaCampaignInsights {
  /** null : la campagne n'a encore rien diffusé. */
  totals: MetaInsightsRow | null;
  daily: MetaInsightsRow[];
}

interface MetaErrorBody {
  error?: { message?: string; code?: number };
}

const INSIGHT_FIELDS =
  'spend,reach,impressions,clicks,inline_link_clicks,frequency,actions,action_values';

/**
 * Lecture des résultats Facebook Ads (Marketing API, permission `ads_read`)
 * avec le token UTILISATEUR de l'entreprise — voir
 * `SocialAccountsService.getAdsAccessToken`. Lecture seule : aucune création
 * ni modification de campagne.
 */
@Injectable()
export class MetaAdsClient {
  private readonly logger = new Logger(MetaAdsClient.name);

  constructor(
    private readonly http: HttpService,
    private readonly configService: ConfigService,
  ) {}

  private get baseUrl(): string {
    const version =
      this.configService.get<string>('META_GRAPH_API_VERSION') ?? 'v21.0';
    return `https://graph.facebook.com/${version}`;
  }

  /** Campagnes de tous les comptes publicitaires de l'utilisateur (50 par compte). */
  async listCampaigns(accessToken: string): Promise<MetaAdCampaign[]> {
    const accounts = await this.get<{
      data: { id: string; name?: string; currency?: string }[];
    }>('/me/adaccounts', {
      fields: 'id,name,currency',
      limit: '25',
      access_token: accessToken,
    });

    const campaigns: MetaAdCampaign[] = [];
    for (const account of accounts.data) {
      const result = await this.get<{
        data: {
          id: string;
          name: string;
          effective_status?: string;
          objective?: string;
          start_time?: string;
          stop_time?: string;
        }[];
      }>(`/${account.id}/campaigns`, {
        fields: 'id,name,effective_status,objective,start_time,stop_time',
        limit: '50',
        access_token: accessToken,
      });
      campaigns.push(
        ...result.data.map((c) => ({
          id: c.id,
          name: c.name,
          status: c.effective_status ?? 'UNKNOWN',
          objective: c.objective ?? null,
          startTime: c.start_time ?? null,
          stopTime: c.stop_time ?? null,
          adAccountId: account.id,
          adAccountName: account.name ?? account.id,
          currency: account.currency ?? 'XAF',
        })),
      );
    }
    return campaigns;
  }

  /** Totaux depuis le début + détail jour par jour (90 jours au plus). */
  async getCampaignInsights(
    accessToken: string,
    campaignId: string,
  ): Promise<MetaCampaignInsights> {
    const [totals, daily] = await Promise.all([
      this.get<{ data: MetaInsightsRow[] }>(`/${campaignId}/insights`, {
        fields: INSIGHT_FIELDS,
        date_preset: 'maximum',
        access_token: accessToken,
      }),
      this.get<{ data: MetaInsightsRow[] }>(`/${campaignId}/insights`, {
        fields: 'spend,reach,impressions,inline_link_clicks,actions',
        date_preset: 'maximum',
        time_increment: '1',
        limit: '90',
        access_token: accessToken,
      }),
    ]);
    return { totals: totals.data[0] ?? null, daily: daily.data };
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
        this.logger.warn(`Meta Ads API error: ${message} (code=${code})`);
        if (code === 190) throw new MetaTokenExpiredError(message, body);
        throw new MetaApiError(message, code, body);
      }
      throw error;
    }
  }
}
