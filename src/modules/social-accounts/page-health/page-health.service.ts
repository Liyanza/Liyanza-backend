import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SocialAccountStatus, SocialPlatform } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { SocialAccountsService } from '../social-accounts.service';
import {
  MetaPageClient,
  type RawPageHealth,
} from '../clients/meta-page.client';
import {
  PageHealthAnalysisClient,
  type PageHealthAnalysis,
} from '../clients/page-health-analysis.client';
import { MetaTokenExpiredError } from '../clients/meta-graph.errors';
import { computePageHealth, type PageHealth } from './page-health';

const DATA_TTL_SECONDS = 60 * 60;
/** Résumé IA « hebdomadaire » : conservé 7 jours, régénérable à la demande. */
const ANALYSIS_TTL_SECONDS = 7 * 24 * 60 * 60;

export const PAGE_HEALTH_ERRORS = {
  RECONNECT: 'PAGE_RECONNECT_REQUIRED',
} as const;

export interface CachedData {
  raw: RawPageHealth;
  fetchedAt: string;
}
export interface CachedAnalysis {
  analysis: PageHealthAnalysis;
  generatedAt: string;
}

/**
 * Santé d'une Page Facebook liée : statistiques des 28 derniers jours
 * comparées aux 28 précédents, meilleures publications, meilleurs créneaux
 * de publication et résumé IA avec actions concrètes.
 */
@Injectable()
export class PageHealthService {
  private readonly logger = new Logger(PageHealthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly socialAccounts: SocialAccountsService,
    private readonly metaPage: MetaPageClient,
    private readonly analysisClient: PageHealthAnalysisClient,
  ) {}

  async getHealth(accountId: string, user: AuthenticatedUser, refresh = false) {
    const { health, fetchedAt } = await this.loadHealth(
      accountId,
      user,
      refresh,
    );
    const cached = await this.redis.get(this.analysisKey(accountId));
    const analysis = cached ? (JSON.parse(cached) as CachedAnalysis) : null;
    return { health, fetchedAt, analysis };
  }

  /** Génère (ou régénère) le résumé IA et le conserve 7 jours. */
  async analyze(accountId: string, user: AuthenticatedUser) {
    const { health } = await this.loadHealth(accountId, user, false);
    let analysis: PageHealthAnalysis | null;
    try {
      analysis = await this.analysisClient.analyze(this.analysisInput(health));
    } catch {
      throw new ServiceUnavailableException(
        'The AI analysis is temporarily unavailable. Please try again in a moment.',
      );
    }
    if (!analysis) {
      throw new ServiceUnavailableException(
        'The AI analysis is not configured on this server.',
      );
    }
    const cached: CachedAnalysis = {
      analysis,
      generatedAt: new Date().toISOString(),
    };
    await this.redis.set(
      this.analysisKey(accountId),
      JSON.stringify(cached),
      ANALYSIS_TTL_SECONDS,
    );
    return cached;
  }

  private async loadHealth(
    accountId: string,
    user: AuthenticatedUser,
    refresh: boolean,
  ): Promise<{ health: PageHealth; fetchedAt: string }> {
    if (!user.companyId) {
      throw new ForbiddenException(
        'You must belong to a company to see a linked Page.',
      );
    }
    const account = await this.prisma.socialAccount.findFirst({
      where: {
        id: accountId,
        companyId: user.companyId,
        platform: SocialPlatform.FACEBOOK,
      },
    });
    if (!account) throw new NotFoundException('Facebook Page not found.');
    if (account.status !== SocialAccountStatus.ACTIVE) {
      throw this.reconnect();
    }

    const key = this.dataKey(account.id);
    let data: CachedData | null = null;
    if (!refresh) {
      const raw = await this.redis.get(key);
      data = raw ? (JSON.parse(raw) as CachedData) : null;
    }
    if (!data) {
      try {
        data = {
          raw: await this.metaPage.getPageHealth(
            this.socialAccounts.decryptAccessToken(account),
            account.externalAccountId,
          ),
          fetchedAt: new Date().toISOString(),
        };
      } catch (error) {
        if (error instanceof MetaTokenExpiredError) throw this.reconnect();
        this.logger.warn(
          `Page health unavailable for ${account.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        throw new ServiceUnavailableException(
          'Facebook Page statistics are temporarily unavailable. Please try again later.',
        );
      }
      await this.redis.set(key, JSON.stringify(data), DATA_TTL_SECONDS);
    }
    return {
      health: computePageHealth(data.raw, new Date()),
      fetchedAt: data.fetchedAt,
    };
  }

  /** Ce que l'IA reçoit : les chiffres calculés et un extrait des meilleures publications. */
  private analysisInput(health: PageHealth) {
    return {
      pageName: health.pageName,
      followers: health.followers,
      periodDays: health.periodDays,
      kpis: health.kpis,
      postsInPeriod: health.postsInPeriod,
      postsPerWeek: health.postsPerWeek,
      avgInteractionsPerPost: health.avgInteractionsPerPost,
      engagementRate: health.engagementRate,
      topPosts: health.topPosts.slice(0, 3).map((p) => ({
        message: p.message.slice(0, 200),
        createdTime: p.createdTime,
        reactions: p.reactions,
        comments: p.comments,
        shares: p.shares,
      })),
      bestTimes: {
        enough: health.bestTimes.enough,
        sampleSize: health.bestTimes.sampleSize,
        top: health.bestTimes.top,
      },
    };
  }

  private reconnect() {
    return new ConflictException({
      code: PAGE_HEALTH_ERRORS.RECONNECT,
      message: 'Reconnect your Facebook Page to see its statistics.',
    });
  }

  private dataKey(accountId: string) {
    return `page-health:data:${accountId}`;
  }

  private analysisKey(accountId: string) {
    return `page-health:analysis:${accountId}`;
  }
}
