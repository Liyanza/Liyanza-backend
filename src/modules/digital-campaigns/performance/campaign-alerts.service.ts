import { Injectable, Logger } from '@nestjs/common';
import { CampaignAlertType, Prisma, Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { NotificationType } from '../../notifications/dto/create-notification.dto';
import type { DetectedAlert } from './alert-rules';

const fcfa = (n: number) => `${new Intl.NumberFormat('fr-FR').format(n)} FCFA`;

/**
 * Texte des notifications (en français, comme les autres notifications du
 * backend). L'interface web affiche sa propre version traduite à partir du
 * type et des chiffres (`data`).
 */
const NOTIFICATION_TEXT: Record<
  CampaignAlertType,
  (d: Record<string, number>) => { title: string; message: string }
> = {
  BUDGET_PACING_FAST: (d) => ({
    title: 'Budget dépensé trop vite',
    message: `${d.spendPct} % du budget est déjà dépensé pour ${d.timePct} % de la durée : la campagne risque de s'arrêter avant la fin. Réduisez le budget quotidien dans le Gestionnaire de publicités Meta.`,
  }),
  BUDGET_PACING_SLOW: (d) => ({
    title: 'La campagne diffuse peu',
    message: `Seulement ${d.spendPct} % du budget dépensé pour ${d.timePct} % de la durée. Vérifiez que la publicité est approuvée et active, puis élargissez l'audience si besoin.`,
  }),
  CPC_HIGH: (d) => ({
    title: 'Coût par clic élevé',
    message: `Chaque clic coûte ${fcfa(d.actualCpc)} contre ${fcfa(d.predictedCpc)} prévus. Testez un nouveau visuel ou élargissez l'audience.`,
  }),
  CTR_LOW: (d) => ({
    title: 'Peu de clics sur la publicité',
    message: `Taux de clic de ${d.actualCtr} % contre ${d.predictedCtr} % prévus : le visuel ou le message accroche peu. Essayez un visuel plus simple avec un appel à l'action clair.`,
  }),
  AUDIENCE_FATIGUE: (d) => ({
    title: 'Audience lassée',
    message: `Les personnes touchées ont vu la publicité ${d.frequency} fois en moyenne et cliquent ${d.ctrDropPct} % moins qu'au début. Renouvelez le visuel ou élargissez l'audience.`,
  }),
  NO_CONVERSIONS: (d) => ({
    title: 'Aucune conversion',
    message: `Aucune conversion alors qu'environ ${d.expected} étaient attendues à ce stade. Vérifiez le lien WhatsApp, le formulaire ou la page de destination.`,
  }),
};

export interface CampaignAlertView {
  id: string;
  type: CampaignAlertType;
  severity: DetectedAlert['severity'];
  data: Record<string, number>;
  createdAt: Date;
}

/**
 * Cycle de vie des alertes d'une campagne : une alerte est ouverte (et
 * notifiée une seule fois) à sa première détection, mise à jour tant que le
 * problème dure, puis fermée dès qu'il disparaît.
 */
@Injectable()
export class CampaignAlertsService {
  private readonly logger = new Logger(CampaignAlertsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async listActive(campaignId: string): Promise<CampaignAlertView[]> {
    const alerts = await this.prisma.campaignAlert.findMany({
      where: { campaignId, resolvedAt: null },
      orderBy: [{ severity: 'desc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        type: true,
        severity: true,
        data: true,
        createdAt: true,
      },
    });
    return alerts.map((a) => ({
      ...a,
      data: a.data as Record<string, number>,
    }));
  }

  async evaluate(
    campaign: { id: string; name: string; launchedById: string },
    companyId: string,
    detected: DetectedAlert[],
  ): Promise<void> {
    const open = await this.prisma.campaignAlert.findMany({
      where: { campaignId: campaign.id, resolvedAt: null },
      select: { id: true, type: true },
    });
    const openByType = new Map(open.map((a) => [a.type, a.id]));
    const detectedTypes = new Set(detected.map((a) => a.type));

    const resolved = open.filter((a) => !detectedTypes.has(a.type));
    if (resolved.length) {
      await this.prisma.campaignAlert.updateMany({
        where: { id: { in: resolved.map((a) => a.id) } },
        data: { resolvedAt: new Date() },
      });
    }

    const created: DetectedAlert[] = [];
    for (const alert of detected) {
      const data = alert.data as Prisma.InputJsonValue;
      const existing = openByType.get(alert.type);
      if (existing) {
        await this.prisma.campaignAlert.update({
          where: { id: existing },
          data: { severity: alert.severity, data },
        });
      } else {
        await this.prisma.campaignAlert.create({
          data: {
            campaignId: campaign.id,
            type: alert.type,
            severity: alert.severity,
            data,
          },
        });
        created.push(alert);
      }
    }
    if (created.length) await this.notify(campaign, companyId, created);
  }

  /** Le créateur de la campagne, les administrateurs et les responsables marketing. */
  private async notify(
    campaign: { id: string; name: string; launchedById: string },
    companyId: string,
    alerts: DetectedAlert[],
  ) {
    const managers = await this.prisma.user.findMany({
      where: { companyId, role: { in: [Role.ADMIN, Role.MARKETING_MANAGER] } },
      select: { id: true },
    });
    const recipients = new Set([
      campaign.launchedById,
      ...managers.map((m) => m.id),
    ]);
    for (const alert of alerts) {
      const text = NOTIFICATION_TEXT[alert.type](alert.data);
      for (const recipientId of recipients) {
        await this.notifications
          .creer({
            title: `${text.title} · ${campaign.name}`,
            message: text.message,
            type:
              alert.severity === 'CRITICAL'
                ? NotificationType.ERROR
                : NotificationType.WARNING,
            recipientId,
          })
          .catch((error: unknown) =>
            this.logger.warn(
              `Alert notification not sent: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
      }
    }
  }
}
