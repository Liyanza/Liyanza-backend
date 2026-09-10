import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { MetricPeriod, Prisma, SocialAccountStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { NotificationType } from '../../notifications/dto/create-notification.dto';
import { SocialAccountsService } from '../social-accounts.service';
import type { SocialPlatformClientInterface } from '../clients/social-platform-client.interface';
import { SOCIAL_PLATFORM_CLIENT_TOKEN } from '../clients/social-platform-client.interface';
import { MetaTokenExpiredError } from '../clients/meta-graph.errors';

interface SyncMetricsPayload {
  socialAccountId: string;
}

/**
 * Ingestion des métriques réelles Meta (BACK-503/504) — consomme la file
 * `social-metrics-sync`, déclenchée à la connexion d'un compte
 * (`SocialAccountsService.handleOAuthCallback`) et sur re-synchronisation
 * manuelle (`POST /social-accounts/:id/sync`). Pas de l'IA : une simple
 * ingestion de données externes, voir
 * `.claude/skills/liyanza-ia-boundary/SKILL.md`.
 */
@Processor('social-metrics-sync')
export class SocialMetricsSyncProcessor extends WorkerHost {
  private readonly logger = new Logger(SocialMetricsSyncProcessor.name);

  constructor(
    private prisma: PrismaService,
    @Inject(SOCIAL_PLATFORM_CLIENT_TOKEN)
    private platformClient: SocialPlatformClientInterface,
    private socialAccountsService: SocialAccountsService,
    private notificationsService: NotificationsService,
  ) {
    super();
  }

  async process(job: Job<SyncMetricsPayload>): Promise<void> {
    if (job.name !== 'sync') {
      return;
    }

    const { socialAccountId } = job.data;
    const account = await this.prisma.socialAccount.findUnique({
      where: { id: socialAccountId },
    });
    if (!account) {
      this.logger.warn(
        `Discarding sync job: socialAccountId=${socialAccountId} no longer exists.`,
      );
      return;
    }
    if (account.status !== SocialAccountStatus.ACTIVE) {
      // Révoqué/expiré entre l'enqueue et le traitement — rien à faire.
      return;
    }

    const accessToken = this.socialAccountsService.decryptAccessToken(account);

    try {
      const insights = await this.platformClient.getInsights(
        account.platform,
        accessToken,
        account.externalAccountId,
      );

      await this.prisma.$transaction([
        this.prisma.platformMetric.create({
          data: {
            socialAccountId: account.id,
            followerCount: insights.followerCount,
            impressions: insights.impressions,
            reach: insights.reach,
            engagementRate: insights.engagementRate,
            avgCpm: insights.avgCpm,
            avgCpc: insights.avgCpc,
            period: MetricPeriod.DAY_28,
            rawPayload: insights.raw as Prisma.InputJsonValue,
          },
        }),
        this.prisma.socialAccount.update({
          where: { id: account.id },
          data: { lastSyncedAt: new Date() },
        }),
      ]);
    } catch (error) {
      if (error instanceof MetaTokenExpiredError) {
        await this.markExpiredAndNotify(account);
        return;
      }
      // Panne transitoire (réseau, 5xx Meta...) : laisser BullMQ retenter
      // selon sa politique de backoff (voir QueueModule).
      throw error;
    }
  }

  private async markExpiredAndNotify(account: {
    id: string;
    platform: string;
    externalAccountId: string;
    externalAccountName: string | null;
    connectedById: string;
  }): Promise<void> {
    const result = await this.prisma.socialAccount.updateMany({
      where: { id: account.id, status: SocialAccountStatus.ACTIVE },
      data: { status: SocialAccountStatus.EXPIRED },
    });
    // Idempotence : si un autre job concurrent a déjà fait la transition,
    // ne pas notifier une seconde fois.
    if (result.count === 0) {
      return;
    }

    await this.notificationsService.creer({
      title: 'Compte Meta à reconnecter',
      message: `Le compte ${account.platform} "${account.externalAccountName ?? account.externalAccountId}" a expiré ou a été révoqué — reconnectez-le pour continuer à alimenter vos simulations digitales.`,
      type: NotificationType.WARNING,
      recipientId: account.connectedById,
    });
  }
}
