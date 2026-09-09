import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EMAIL_PROVIDER_TOKEN } from '../../mail/interfaces/email-provider.interface';
import type { EmailProvider } from '../../mail/interfaces/email-provider.interface';
import {
  CreateNotificationDto,
  NotificationType,
} from '../dto/create-notification.dto';

interface SendTemporaryPasswordPayload {
  email: string;
  firstName: string;
  temporaryPassword: string;
}

/**
 * Consomme la file `notifications` (déclarée dans `QueueModule`, BACK-301).
 *
 * Gère deux types de jobs :
 * - `create` : persiste la notification in-app (déplacé depuis
 *   `NotificationsService.creer()`, BACK-210) puis envoie l'email
 *   correspondant au destinataire (BACK-302, canal email uniquement).
 * - `send-temporary-password` : enfilée par `UsersService.createSubAccount`
 *   mais jusqu'ici jamais consommée (aucun processor n'existait sur cette
 *   file) — envoie le mot de passe temporaire par email.
 */
@Processor('notifications')
export class NotificationsProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationsProcessor.name);

  constructor(
    private prisma: PrismaService,
    @Inject(EMAIL_PROVIDER_TOKEN) private emailProvider: EmailProvider,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case 'create':
        return this.handleCreate(job as Job<CreateNotificationDto>);
      case 'send-temporary-password':
        return this.handleSendTemporaryPassword(
          job as Job<SendTemporaryPasswordPayload>,
        );
      default:
        this.logger.warn(
          `Unknown job "${job.name}" on queue "notifications" — ignored.`,
        );
    }
  }

  private async handleCreate(job: Job<CreateNotificationDto>): Promise<void> {
    const dto = job.data;

    let notification;
    try {
      // Idempotence : `job.id` reste stable à travers les tentatives BullMQ
      // (3 essais, backoff exponentiel — voir QueueModule). Utiliser cet
      // identifiant comme clé primaire évite de dupliquer la notification
      // en base si l'écriture Prisma a déjà réussi lors d'une tentative
      // précédente mais que l'envoi d'email, lui, avait échoué ensuite.
      notification = await this.prisma.notification.upsert({
        where: { id: job.id! },
        update: {},
        create: {
          id: job.id!,
          title: dto.title,
          message: dto.message,
          type: dto.type ?? NotificationType.INFO,
          sentAt: new Date(),
          readStatus: 'UNREAD',
          recipientId: dto.recipientId,
        },
        include: { recipient: { select: { email: true } } },
      });
    } catch (error) {
      // Un destinataire supprimé entre l'enqueue et le traitement du job
      // (violation de contrainte FK, P2003) ne doit jamais être retenté
      // indéfiniment — cf. le même correctif sur QrCodeScanProcessor.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2003'
      ) {
        this.logger.warn(
          `Discarding notification job: recipientId=${dto.recipientId} does not exist.`,
        );
        return;
      }
      throw error;
    }

    await this.emailProvider.send({
      to: notification.recipient.email,
      subject: dto.title,
      text: dto.message,
    });
  }

  private async handleSendTemporaryPassword(
    job: Job<SendTemporaryPasswordPayload>,
  ): Promise<void> {
    const { email, firstName, temporaryPassword } = job.data;
    await this.emailProvider.send({
      to: email,
      subject: 'Votre compte Liyanza — mot de passe temporaire',
      text:
        `Bonjour ${firstName},\n\n` +
        `Un compte a été créé pour vous sur Liyanza. Votre mot de passe temporaire est : ${temporaryPassword}\n\n` +
        `Merci de le changer dès votre première connexion.`,
    });
  }
}
