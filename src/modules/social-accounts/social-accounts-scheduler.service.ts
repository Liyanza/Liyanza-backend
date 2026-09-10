import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SocialAccountStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/dto/create-notification.dto';

/**
 * Fenêtre (jours) avant `tokenExpiresAt` à partir de laquelle un compte
 * social est considéré "bientôt expiré". Constante métier documentée
 * plutôt que variable d'env — même choix que `UPCOMING_DUE_WINDOW_HOURS`
 * (BACK-306) / `DEVIATION_ALERT_THRESHOLD_MINUTES` (BACK-304).
 */
export const SOCIAL_TOKEN_EXPIRY_WARNING_WINDOW_DAYS = 7;

/**
 * Détection d'expiration de token Meta (BACK-504) : Meta ne propose pas de
 * rafraîchissement silencieux d'un token long-lived sans ré-interaction de
 * l'utilisateur — la seule action possible côté serveur est de prévenir à
 * l'avance pour qu'un ADMIN/MARKETING_MANAGER reconnecte le compte avant
 * l'expiration réelle (qui bascule `status: EXPIRED` au prochain sync raté,
 * voir `SocialMetricsSyncProcessor`).
 */
@Injectable()
export class SocialAccountsSchedulerService {
  private readonly logger = new Logger(SocialAccountsSchedulerService.name);

  constructor(
    private prisma: PrismaService,
    private notificationsService: NotificationsService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async checkExpiringSocialAccounts(): Promise<void> {
    const now = new Date();
    const soon = new Date(
      now.getTime() +
        SOCIAL_TOKEN_EXPIRY_WARNING_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );

    const expiringAccounts = await this.prisma.socialAccount.findMany({
      where: {
        status: SocialAccountStatus.ACTIVE,
        tokenExpiresAt: { gte: now, lte: soon },
        expiryReminderSentAt: null,
      },
    });

    if (expiringAccounts.length === 0) {
      return;
    }

    // Idempotence explicite : `expiryReminderSentAt` sort le compte du
    // `where` ci-dessus dès la prochaine exécution, une seule relance par
    // compte tant qu'il n'est pas reconnecté (voir
    // `SocialAccountsService.handleOAuthCallback`, qui remet ce champ à
    // `null` sur reconnexion).
    await this.prisma.socialAccount.updateMany({
      where: { id: { in: expiringAccounts.map((a) => a.id) } },
      data: { expiryReminderSentAt: now },
    });

    for (const account of expiringAccounts) {
      await this.notificationsService.creer({
        title: 'Compte Meta bientôt expiré',
        message: `Le compte ${account.platform} "${account.externalAccountName ?? account.externalAccountId}" expirera bientôt — reconnectez-le pour ne pas interrompre la synchronisation des métriques.`,
        type: NotificationType.WARNING,
        recipientId: account.connectedById,
      });
    }

    this.logger.log(
      `${expiringAccounts.length} relance(s) d'expiration de compte social envoyée(s).`,
    );
  }
}
