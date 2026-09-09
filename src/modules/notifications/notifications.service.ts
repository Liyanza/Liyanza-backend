import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { CreateNotificationDto } from './dto/create-notification.dto';
import { NotificationQueryDto } from './dto/notification-query.dto';
import { QueueService } from '../queue/queue.service';

@Injectable()
export class NotificationsService {
  constructor(
    private prisma: PrismaService,
    private queueService: QueueService,
  ) {}

  /**
   * Enfile la création de la notification sur la file `notifications`
   * (BACK-210/BACK-302) au lieu d'écrire en direct via Prisma : la
   * persistance in-app et l'envoi de l'email associé sont désormais gérés
   * par `NotificationsProcessor`, en dehors du chemin de requête synchrone.
   * Le destinataire est toujours résolu depuis le DTO — jamais depuis
   * l'utilisateur de la requête.
   */
  async creer(dto: CreateNotificationDto): Promise<void> {
    await this.queueService.addJob('notifications', 'create', dto);
  }

  /**
   * Returns all notifications for the authenticated user.
   * Can be filtered by readStatus (UNREAD/READ/ALL).
   */
  async findAll(user: AuthenticatedUser, query: NotificationQueryDto) {
    const where: Prisma.NotificationWhereInput = {
      recipientId: user.userId,
    };

    if (query.readStatus && query.readStatus !== 'ALL') {
      where.readStatus = query.readStatus;
    }

    // Pagination : use offset if provided, otherwise compute skip from page and limit
    const limit = query.limit ?? 20;
    const page = query.page ?? 1;
    const skip = query.offset !== undefined ? query.offset : (page - 1) * limit;

    const [items, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { sentAt: 'desc' },
        take: limit,
        skip,
      }),
      this.prisma.notification.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Marks a notification as read. Idempotent: if already read, returns the existing notification.
   * Throws NotFoundException if the notification does not exist or belongs to another user.
   */
  async markAsLue(id: string, user: AuthenticatedUser) {
    const notification = await this.prisma.notification.findFirst({
      where: {
        id,
        recipientId: user.userId,
      },
    });

    if (!notification) {
      throw new NotFoundException('Notification not found.');
    }

    if (notification.readStatus === 'READ') {
      return notification;
    }

    return this.prisma.notification.update({
      where: { id },
      data: { readStatus: 'READ' },
    });
  }
}
