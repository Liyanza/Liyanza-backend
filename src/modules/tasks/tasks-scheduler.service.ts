import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { TaskStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/dto/create-notification.dto';

/**
 * Fenêtre (heures) avant `dueDate` à partir de laquelle une tâche est
 * considérée "proche de l'échéance" et déclenche une relance. Constante
 * métier documentée plutôt que variable d'env — même choix que
 * `DEVIATION_ALERT_THRESHOLD_MINUTES` (BACK-304).
 */
export const UPCOMING_DUE_WINDOW_HOURS = 24;

/**
 * Détection d'échéances (BACK-306) : dépend du modèle `Task`/`TaskAssignee`
 * de BACK-212. Deux jobs, exécutés toutes les heures :
 * - Échéances dépassées → passage en `LATE` + notification.
 * - Échéances proches (< 24 h), pas encore relancées → notification +
 *   `reminderSentAt` posé (idempotence : sans ce champ, chaque exécution du
 *   cron renotifierait les mêmes tâches tant qu'elles restent dans la
 *   fenêtre).
 *
 * Chaque job notifie individuellement chaque assigné (`TaskAssignee`), pas
 * le créateur de la tâche — c'est l'assigné qui doit agir.
 */
@Injectable()
export class TasksSchedulerService {
  private readonly logger = new Logger(TasksSchedulerService.name);

  constructor(
    private prisma: PrismaService,
    private notificationsService: NotificationsService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async handleOverdueTasks(): Promise<void> {
    const now = new Date();
    const overdueTasks = await this.prisma.task.findMany({
      where: {
        dueDate: { lt: now },
        status: { notIn: [TaskStatus.DONE, TaskStatus.LATE] },
      },
      include: { assignees: true },
    });

    if (overdueTasks.length === 0) {
      return;
    }

    // Bulk update naturellement idempotent : une tâche déjà passée en LATE
    // ne remonte plus dans le `where` ci-dessus à la prochaine exécution.
    await this.prisma.task.updateMany({
      where: { id: { in: overdueTasks.map((t) => t.id) } },
      data: { status: TaskStatus.LATE },
    });

    for (const task of overdueTasks) {
      for (const assignee of task.assignees) {
        await this.notificationsService.creer({
          title: 'Tâche en retard',
          message: `La tâche "${task.title}" a dépassé son échéance et est passée en retard.`,
          type: NotificationType.WARNING,
          recipientId: assignee.userId,
        });
      }
    }

    this.logger.log(`${overdueTasks.length} tâche(s) passée(s) en retard.`);
  }

  @Cron(CronExpression.EVERY_HOUR)
  async handleUpcomingDueTasks(): Promise<void> {
    const now = new Date();
    const upcomingLimit = new Date(
      now.getTime() + UPCOMING_DUE_WINDOW_HOURS * 60 * 60 * 1000,
    );

    const upcomingTasks = await this.prisma.task.findMany({
      where: {
        dueDate: { gte: now, lte: upcomingLimit },
        status: { notIn: [TaskStatus.DONE, TaskStatus.LATE] },
        reminderSentAt: null,
      },
      include: { assignees: true },
    });

    if (upcomingTasks.length === 0) {
      return;
    }

    // Idempotence explicite : `reminderSentAt` sort la tâche du `where`
    // ci-dessus dès la prochaine exécution, une seule relance par tâche.
    await this.prisma.task.updateMany({
      where: { id: { in: upcomingTasks.map((t) => t.id) } },
      data: { reminderSentAt: now },
    });

    for (const task of upcomingTasks) {
      for (const assignee of task.assignees) {
        await this.notificationsService.creer({
          title: 'Échéance de tâche proche',
          message: `La tâche "${task.title}" arrive à échéance dans moins de ${UPCOMING_DUE_WINDOW_HOURS}h.`,
          type: NotificationType.INFO,
          recipientId: assignee.userId,
        });
      }
    }

    this.logger.log(`${upcomingTasks.length} relance(s) de tâche envoyée(s).`);
  }
}
