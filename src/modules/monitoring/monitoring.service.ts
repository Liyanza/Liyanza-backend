import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DiffusionsService } from '../diffusions/diffusions.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/dto/create-notification.dto';
import { RecordDetectionDto } from './dto/record-detection.dto';

/**
 * Écart (minutes) entre l'heure planifiée et l'heure détectée au-delà
 * duquel le responsable de la campagne est notifié. Valeur métier, pas une
 * config d'infra — même logique que `MAX_MEDIA_SIZE_BYTES`
 * (BACK-307) : constante documentée plutôt que variable d'env.
 */
export const DEVIATION_ALERT_THRESHOLD_MINUTES = 15;

@Injectable()
export class MonitoringService {
  constructor(
    private prisma: PrismaService,
    private diffusionsService: DiffusionsService,
    private notificationsService: NotificationsService,
  ) {}

  /**
   * Ingère le résultat d'une détection déjà effectuée par le futur service
   * `Liyanza-ia` (BACK-304) — ce dépôt ne fait qu'enregistrer le constat et
   * notifier en cas d'écart, jamais l'analyse audio elle-même.
   *
   * Idempotence webhook : une détection déjà enregistrée pour cette
   * diffusion (rejeu réseau côté appelant) n'est PAS traitée comme une
   * erreur — on renvoie l'état actuel sans déclencher de notification en
   * double. Sous concurrence, c'est le verrou optimiste de
   * `DiffusionsService.applyConstat` qui tranche : au plus un appel gagne,
   * tous les autres retombent ici sur le même chemin idempotent.
   */
  async recordDetection(dto: RecordDetectionDto) {
    const broadcast = await this.prisma.broadcast.findUnique({
      where: { id: dto.diffusionId },
      include: { campaign: { include: { launchedBy: true } } },
    });
    if (!broadcast) {
      throw new NotFoundException('Diffusion introuvable.');
    }

    let updated;
    try {
      updated = await this.diffusionsService.applyConstat(dto.diffusionId, {
        actualBroadcastAt: dto.detectedAt,
        audioProof: dto.audioProof,
      });
    } catch (error) {
      if (error instanceof ConflictException) {
        return this.prisma.broadcast.findUniqueOrThrow({
          where: { id: dto.diffusionId },
        });
      }
      throw error;
    }

    const ecartMinutes = Math.round(
      (new Date(dto.detectedAt).getTime() - broadcast.scheduledAt.getTime()) /
        60000,
    );
    if (Math.abs(ecartMinutes) > DEVIATION_ALERT_THRESHOLD_MINUTES) {
      await this.notificationsService.creer({
        title: 'Écart de diffusion détecté',
        message:
          `La diffusion "${broadcast.mediaType}" de la campagne "${broadcast.campaign.name}" ` +
          `a été détectée avec un écart de ${ecartMinutes} minute(s) par rapport à l'horaire planifié.`,
        type: NotificationType.WARNING,
        recipientId: broadcast.campaign.launchedBy.id,
      });
    }

    return updated;
  }
}
