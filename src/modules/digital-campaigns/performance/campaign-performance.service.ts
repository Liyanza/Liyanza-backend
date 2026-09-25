import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { SocialAccountsService } from '../../social-accounts/social-accounts.service';
import {
  MetaAdsClient,
  type MetaCampaignInsights,
} from '../../social-accounts/clients/meta-ads.client';
import {
  MetaApiError,
  MetaTokenExpiredError,
} from '../../social-accounts/clients/meta-graph.errors';
import { DigitalCampaignsService } from '../digital-campaigns.service';
import { comparePerformance } from './performance-comparison';
import { LocalBenchmarksService } from './local-benchmarks.service';

/** Résultats Meta mis en cache : l'API est lente et limitée en appels. */
const INSIGHTS_TTL_SECONDS = 30 * 60;

/**
 * Codes d'erreur métier renvoyés au client (champ `code`) pour qu'il affiche
 * la bonne action : reconnecter Facebook, réessayer plus tard…
 */
export const PERFORMANCE_ERRORS = {
  NOT_CONNECTED: 'META_ADS_NOT_CONNECTED',
  TOKEN_EXPIRED: 'META_ADS_TOKEN_EXPIRED',
} as const;

// Erreurs Meta de permission : ads_read absent ou refusé, pas de compte pub.
const PERMISSION_ERROR_CODES = new Set([10, 200, 294]);

/**
 * « Prévu vs réel » : lie une campagne digitale à sa campagne Facebook Ads et
 * compare ses résultats réels à la dernière simulation.
 */
@Injectable()
export class CampaignPerformanceService {
  private readonly logger = new Logger(CampaignPerformanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly digitalCampaigns: DigitalCampaignsService,
    private readonly socialAccounts: SocialAccountsService,
    private readonly metaAds: MetaAdsClient,
    private readonly localBenchmarks: LocalBenchmarksService,
  ) {}

  /** Campagnes Facebook Ads que l'entreprise peut relier. */
  async listMetaCampaigns(campaignId: string, user: AuthenticatedUser) {
    await this.digitalCampaigns.validateDigitalCampaignAccess(campaignId, user);
    const token = await this.adsToken(user.companyId!);
    try {
      return await this.metaAds.listCampaigns(token);
    } catch (error) {
      this.rethrow(error);
    }
  }

  async linkMetaCampaign(
    campaignId: string,
    metaCampaignId: string,
    user: AuthenticatedUser,
  ) {
    const campaign = await this.digitalCampaigns.validateDigitalCampaignAccess(
      campaignId,
      user,
    );
    const details = await this.requireDetails(campaign.id);
    const token = await this.adsToken(user.companyId!);

    // Jamais un identifiant fourni par le client sans vérification : la
    // campagne doit appartenir à un compte publicitaire accessible.
    let campaigns;
    try {
      campaigns = await this.metaAds.listCampaigns(token);
    } catch (error) {
      this.rethrow(error);
    }
    const meta = campaigns.find((c) => c.id === metaCampaignId);
    if (!meta) {
      throw new NotFoundException(
        'This Facebook Ads campaign is not accessible with the linked account.',
      );
    }

    await this.prisma.digitalCampaignDetails.update({
      where: { id: details.id },
      data: {
        metaAdAccountId: meta.adAccountId,
        metaCampaignId: meta.id,
        metaCampaignName: meta.name,
        metaAdCurrency: meta.currency,
        metaCampaignLinkedAt: new Date(),
      },
    });
    await this.redis.del(this.cacheKey(campaign.id));
    return this.getPerformance(campaign.id, user);
  }

  async unlinkMetaCampaign(campaignId: string, user: AuthenticatedUser) {
    const campaign = await this.digitalCampaigns.validateDigitalCampaignAccess(
      campaignId,
      user,
    );
    const details = await this.requireDetails(campaign.id);
    await this.prisma.digitalCampaignDetails.update({
      where: { id: details.id },
      data: {
        metaAdAccountId: null,
        metaCampaignId: null,
        metaCampaignName: null,
        metaAdCurrency: null,
        metaCampaignLinkedAt: null,
      },
    });
    await this.redis.del(this.cacheKey(campaign.id));
    return { linked: false as const };
  }

  /**
   * Comparaison prévu/réel. `{ linked: false }` tant qu'aucune campagne
   * Facebook Ads n'est reliée. `refresh` ignore le cache (30 min).
   */
  async getPerformance(
    campaignId: string,
    user: AuthenticatedUser,
    refresh = false,
  ) {
    const campaign = await this.digitalCampaigns.validateDigitalCampaignAccess(
      campaignId,
      user,
    );
    const details = await this.prisma.digitalCampaignDetails.findUnique({
      where: { campaignId: campaign.id },
    });
    if (!details?.metaCampaignId) return { linked: false as const };

    const key = this.cacheKey(campaign.id);
    let cached: { insights: MetaCampaignInsights; fetchedAt: string } | null =
      null;
    if (!refresh) {
      const raw = await this.redis.get(key);
      cached = raw ? (JSON.parse(raw) as typeof cached) : null;
    }
    if (!cached) {
      const token = await this.adsToken(user.companyId!);
      try {
        cached = {
          insights: await this.metaAds.getCampaignInsights(
            token,
            details.metaCampaignId,
          ),
          fetchedAt: new Date().toISOString(),
        };
      } catch (error) {
        this.rethrow(error);
      }
      await this.redis.set(key, JSON.stringify(cached), INSIGHTS_TTL_SECONDS);
      // Résultats frais : ils alimentent aussi les références de coûts locales.
      await this.localBenchmarks
        .record({
          campaignId: campaign.id,
          companyId: user.companyId!,
          objective: details.objective,
          locations: details.targetLocations,
          currency: details.metaAdCurrency ?? 'XAF',
          totals: cached.insights.totals,
        })
        .catch((error: unknown) =>
          this.logger.warn(
            `Benchmark observation not saved: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
    }

    const simulation = await this.prisma.digitalSimulation.findFirst({
      where: { campaignId: campaign.id },
      orderBy: { simulatedAt: 'desc' },
      select: {
        id: true,
        simulatedAt: true,
        predictedReach: true,
        predictedCtr: true,
        predictedRoas: true,
        avgCpc: true,
        costPerAcquisition: true,
        scenarios: true,
      },
    });

    return {
      linked: true as const,
      link: {
        metaCampaignId: details.metaCampaignId,
        metaCampaignName: details.metaCampaignName,
        metaAdAccountId: details.metaAdAccountId,
        linkedAt: details.metaCampaignLinkedAt,
      },
      simulation: simulation
        ? { id: simulation.id, simulatedAt: simulation.simulatedAt }
        : null,
      fetchedAt: cached.fetchedAt,
      comparison: comparePerformance({
        objective: details.objective,
        plannedBudget: campaign.plannedBudget.toNumber(),
        startDate: campaign.startDate,
        endDate: campaign.endDate,
        now: new Date(),
        currency: details.metaAdCurrency ?? 'XAF',
        insights: cached.insights,
        simulation,
      }),
    };
  }

  private async requireDetails(campaignId: string) {
    const details = await this.prisma.digitalCampaignDetails.findUnique({
      where: { campaignId },
    });
    if (!details) {
      throw new BadRequestException(
        'Complete the campaign objective, audience and budget first.',
      );
    }
    return details;
  }

  private async adsToken(companyId: string) {
    const token = await this.socialAccounts.getAdsAccessToken(companyId);
    if (!token) {
      throw new ConflictException({
        code: PERFORMANCE_ERRORS.NOT_CONNECTED,
        message:
          'Reconnect your Facebook Page to give Kiyanza access to your ad results.',
      });
    }
    return token;
  }

  /** Traduit une erreur Meta en réponse HTTP exploitable par le client. */
  private rethrow(error: unknown): never {
    if (error instanceof MetaTokenExpiredError) {
      throw new ConflictException({
        code: PERFORMANCE_ERRORS.TOKEN_EXPIRED,
        message: 'Your Facebook session has expired. Reconnect your Page.',
      });
    }
    if (
      error instanceof MetaApiError &&
      error.code !== undefined &&
      PERMISSION_ERROR_CODES.has(error.code)
    ) {
      throw new ConflictException({
        code: PERFORMANCE_ERRORS.NOT_CONNECTED,
        message:
          'Reconnect your Facebook Page and allow access to your ad accounts.',
      });
    }
    this.logger.warn(
      `Meta Ads unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw new ServiceUnavailableException(
      'Facebook Ads results are temporarily unavailable. Please try again later.',
    );
  }

  private cacheKey(campaignId: string) {
    return `meta:performance:${campaignId}`;
  }
}
