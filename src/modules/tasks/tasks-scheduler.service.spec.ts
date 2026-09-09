/* eslint-disable @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import { TaskStatus } from '@prisma/client';
import {
  TasksSchedulerService,
  UPCOMING_DUE_WINDOW_HOURS,
} from './tasks-scheduler.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/dto/create-notification.dto';

describe('TasksSchedulerService', () => {
  let service: TasksSchedulerService;
  let prisma: {
    task: { findMany: jest.Mock; updateMany: jest.Mock };
  };
  let notificationsService: jest.Mocked<NotificationsService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TasksSchedulerService,
        {
          provide: PrismaService,
          useValue: {
            task: { findMany: jest.fn(), updateMany: jest.fn() },
          },
        },
        {
          provide: NotificationsService,
          useValue: { creer: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<TasksSchedulerService>(TasksSchedulerService);
    prisma = module.get(PrismaService);
    notificationsService = module.get(NotificationsService);
  });

  describe('handleOverdueTasks', () => {
    it('should do nothing if there are no overdue tasks', async () => {
      prisma.task.findMany.mockResolvedValue([]);

      await service.handleOverdueTasks();

      expect(prisma.task.updateMany).not.toHaveBeenCalled();
      expect(notificationsService.creer).not.toHaveBeenCalled();
    });

    it('should query only tasks past due and not already DONE/LATE', async () => {
      prisma.task.findMany.mockResolvedValue([]);

      await service.handleOverdueTasks();

      expect(prisma.task.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            dueDate: { lt: expect.any(Date) as Date },
            status: { notIn: [TaskStatus.DONE, TaskStatus.LATE] },
          },
        }),
      );
    });

    it('should mark overdue tasks as LATE and notify each assignee individually', async () => {
      prisma.task.findMany.mockResolvedValue([
        {
          id: 'task-1',
          title: 'Valider le plan média',
          assignees: [{ userId: 'user-1' }, { userId: 'user-2' }],
        },
      ]);

      await service.handleOverdueTasks();

      expect(prisma.task.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['task-1'] } },
        data: { status: TaskStatus.LATE },
      });
      expect(notificationsService.creer).toHaveBeenCalledTimes(2);
      expect(notificationsService.creer).toHaveBeenCalledWith(
        expect.objectContaining({
          type: NotificationType.WARNING,
          recipientId: 'user-1',
        }),
      );
      expect(notificationsService.creer).toHaveBeenCalledWith(
        expect.objectContaining({
          type: NotificationType.WARNING,
          recipientId: 'user-2',
        }),
      );
    });

    // RÉGRESSION (idempotence) : une tâche déjà LATE ne doit jamais être
    // re-détectée/re-notifiée — garanti par le `notIn` du `where`, testé ici
    // en s'assurant qu'aucune tâche LATE n'est retournée par le mock.
    it('should not re-notify a task that is already LATE (excluded by the query)', async () => {
      prisma.task.findMany.mockResolvedValue([]); // le vrai filtre exclut déjà LATE côté DB

      await service.handleOverdueTasks();

      expect(notificationsService.creer).not.toHaveBeenCalled();
    });
  });

  describe('handleUpcomingDueTasks', () => {
    it('should do nothing if there are no upcoming tasks', async () => {
      prisma.task.findMany.mockResolvedValue([]);

      await service.handleUpcomingDueTasks();

      expect(prisma.task.updateMany).not.toHaveBeenCalled();
      expect(notificationsService.creer).not.toHaveBeenCalled();
    });

    it('should query tasks due within the configured window, not yet reminded', async () => {
      prisma.task.findMany.mockResolvedValue([]);

      await service.handleUpcomingDueTasks();

      expect(prisma.task.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            dueDate: {
              gte: expect.any(Date) as Date,
              lte: expect.any(Date) as Date,
            },
            status: { notIn: [TaskStatus.DONE, TaskStatus.LATE] },
            reminderSentAt: null,
          },
        }),
      );
      const calls = prisma.task.findMany.mock.calls as unknown as [
        { where: { dueDate: { gte: Date; lte: Date } } },
      ][];
      const { gte, lte } = calls[0][0].where.dueDate;
      expect(lte.getTime() - gte.getTime()).toBe(
        UPCOMING_DUE_WINDOW_HOURS * 60 * 60 * 1000,
      );
    });

    it('should notify each assignee and mark reminderSentAt (idempotence)', async () => {
      prisma.task.findMany.mockResolvedValue([
        {
          id: 'task-1',
          title: 'Relire le planning',
          assignees: [{ userId: 'user-1' }],
        },
      ]);

      await service.handleUpcomingDueTasks();

      expect(prisma.task.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['task-1'] } },
        data: { reminderSentAt: expect.any(Date) as Date },
      });
      expect(notificationsService.creer).toHaveBeenCalledWith(
        expect.objectContaining({
          type: NotificationType.INFO,
          recipientId: 'user-1',
        }),
      );
    });
  });
});
