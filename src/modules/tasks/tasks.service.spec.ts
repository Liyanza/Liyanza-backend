/* eslint-disable @typescript-eslint/unbound-method */

import { Test, TestingModule } from '@nestjs/testing';
import {
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { TasksService } from './tasks.service';
import { PrismaService } from '../prisma/prisma.service';
import { Role, TaskStatus } from '@prisma/client';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

describe('TasksService', () => {
  let service: TasksService;
  let prisma: jest.Mocked<PrismaService>;

  const admin: AuthenticatedUser = {
    userId: 'admin-1',
    email: 'admin@test.com',
    role: Role.ADMIN,
    companyId: 'company-1',
  };

  const communityManager: AuthenticatedUser = {
    userId: 'user-2',
    email: 'cm@test.com',
    role: Role.COMMUNITY_MANAGER,
    companyId: 'company-1',
  };

  const mockTask = {
    id: 'task-1',
    title: 'Préparer la campagne',
    description: null,
    status: TaskStatus.TODO,
    dueDate: null,
    companyId: 'company-1',
    createdById: 'admin-1',
    campaignId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  // Client transactionnel : objet mock DISTINCT de `prisma`, pour détecter
  // toute utilisation accidentelle de `this.prisma` dans le callback
  // `$transaction` — voir .claude/skills/liyanza-testing/SKILL.md.
  const buildTxClient = () => ({
    task: {
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    taskAssignee: {
      createMany: jest.fn(),
      deleteMany: jest.fn(),
    },
  });

  let txClient: ReturnType<typeof buildTxClient>;

  beforeEach(async () => {
    txClient = buildTxClient();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TasksService,
        {
          provide: PrismaService,
          useValue: {
            task: {
              create: jest.fn(),
              findMany: jest.fn(),
              count: jest.fn(),
              findFirst: jest.fn(),
              findUniqueOrThrow: jest.fn(),
              updateMany: jest.fn(),
            },
            taskAssignee: {
              createMany: jest.fn(),
              deleteMany: jest.fn(),
            },
            campaign: {
              findUnique: jest.fn(),
            },
            user: {
              findMany: jest.fn(),
            },
            $transaction: jest.fn((cb: (tx: typeof txClient) => unknown) =>
              cb(txClient),
            ),
          },
        },
      ],
    }).compile();

    service = module.get<TasksService>(TasksService);
    prisma = module.get(PrismaService);
  });

  describe('create', () => {
    const dto = {
      title: 'Préparer la campagne',
      assigneeIds: ['user-2', 'user-3'],
    };

    it('should throw ForbiddenException if the user has no company', async () => {
      const userNoCompany = { ...admin, companyId: null };
      await expect(service.create(dto, userNoCompany)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should throw BadRequestException if an assignee does not belong to the company', async () => {
      (prisma.user.findMany as jest.Mock).mockResolvedValue([{ id: 'user-2' }]); // only 1 of the 2 requested ids resolves

      await expect(service.create(dto, admin)).rejects.toThrow(
        BadRequestException,
      );
      expect(txClient.task.create).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException if the linked campaign does not exist', async () => {
      (prisma.user.findMany as jest.Mock).mockResolvedValue([
        { id: 'user-2' },
        { id: 'user-3' },
      ]);
      (prisma.campaign.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.create({ ...dto, campaignId: 'campaign-1' }, admin),
      ).rejects.toThrow(NotFoundException);
    });

    // RÉGRESSION (isolation multi-tenant) : une campagne d'une autre
    // entreprise ne doit jamais pouvoir être liée à une tâche, même si son id
    // est valide et connu de l'appelant.
    it('should throw NotFoundException if the linked campaign belongs to another company', async () => {
      (prisma.user.findMany as jest.Mock).mockResolvedValue([
        { id: 'user-2' },
        { id: 'user-3' },
      ]);
      (prisma.campaign.findUnique as jest.Mock).mockResolvedValue({
        id: 'campaign-1',
        launchedBy: { companyId: 'other-company' },
      });

      await expect(
        service.create({ ...dto, campaignId: 'campaign-1' }, admin),
      ).rejects.toThrow(NotFoundException);
    });

    it('should create the task and its assignees through the tx client, not this.prisma', async () => {
      (prisma.user.findMany as jest.Mock).mockResolvedValue([
        { id: 'user-2' },
        { id: 'user-3' },
      ]);
      txClient.task.create.mockResolvedValue(mockTask);
      (prisma.task.findUniqueOrThrow as jest.Mock).mockResolvedValue({
        ...mockTask,
        assignees: [],
      });

      const result = await service.create(dto, admin);

      expect(txClient.task.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            title: dto.title,
            companyId: admin.companyId,
            createdById: admin.userId,
          }) as unknown,
        }),
      );
      expect(txClient.taskAssignee.createMany).toHaveBeenCalledWith({
        data: [
          { taskId: mockTask.id, userId: 'user-2' },
          { taskId: mockTask.id, userId: 'user-3' },
        ],
      });
      // Ne jamais avoir besoin de vérifier prisma.task.create ici : s'il a
      // été appelé, c'est justement le bug qu'on veut détecter.
      expect(result).toMatchObject({ id: mockTask.id });
    });
  });

  describe('findOne', () => {
    it('should return a task scoped to the user company', async () => {
      (prisma.task.findFirst as jest.Mock).mockResolvedValue({
        ...mockTask,
        assignees: [],
      });

      const result = await service.findOne('task-1', admin);
      expect(result).toMatchObject({ id: 'task-1' });
      expect(prisma.task.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'task-1', companyId: admin.companyId },
        }),
      );
    });

    // Isolation multi-tenant — test minimal obligatoire (DoD BACK-212).
    it('should throw NotFoundException for a task belonging to another company', async () => {
      (prisma.task.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        service.findOne('task-from-other-company', admin),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('findAll', () => {
    it('should scope the list to the user company and paginate', async () => {
      (prisma.task.findMany as jest.Mock).mockResolvedValue([
        { ...mockTask, assignees: [] },
      ]);
      (prisma.task.count as jest.Mock).mockResolvedValue(1);

      const result = await service.findAll({ page: 1, limit: 10 }, admin);

      expect(prisma.task.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { companyId: admin.companyId },
        }),
      );
      expect(result.total).toBe(1);
      expect(result.items).toHaveLength(1);
    });

    it('should filter by status and assigneeId when provided', async () => {
      (prisma.task.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.task.count as jest.Mock).mockResolvedValue(0);

      await service.findAll(
        { page: 1, limit: 10, status: TaskStatus.DONE, assigneeId: 'user-2' },
        admin,
      );

      expect(prisma.task.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            companyId: admin.companyId,
            status: TaskStatus.DONE,
            assignees: { some: { userId: 'user-2' } },
          },
        }),
      );
    });
  });

  describe('update', () => {
    it('should throw NotFoundException if the task does not belong to the company', async () => {
      (prisma.task.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        service.update('task-x', { title: 'Nouveau titre' }, admin),
      ).rejects.toThrow(NotFoundException);
    });

    it('should update through the tx client with company scope reaffirmed', async () => {
      (prisma.task.findFirst as jest.Mock).mockResolvedValue(mockTask);
      txClient.task.updateMany.mockResolvedValue({ count: 1 });
      (prisma.task.findUniqueOrThrow as jest.Mock).mockResolvedValue({
        ...mockTask,
        title: 'Nouveau titre',
        assignees: [],
      });

      const result = await service.update(
        'task-1',
        { title: 'Nouveau titre' },
        admin,
      );

      expect(txClient.task.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'task-1', companyId: admin.companyId },
        }),
      );
      expect(result.title).toBe('Nouveau titre');
    });

    // Verrou optimiste — cas de conflit (count: 0).
    it('should throw ConflictException if the task disappeared between the read and the write', async () => {
      (prisma.task.findFirst as jest.Mock).mockResolvedValue(mockTask);
      txClient.task.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.update('task-1', { title: 'Nouveau titre' }, admin),
      ).rejects.toThrow(ConflictException);
    });

    it('should throw BadRequestException if a new assignee does not belong to the company', async () => {
      (prisma.task.findFirst as jest.Mock).mockResolvedValue(mockTask);
      (prisma.user.findMany as jest.Mock).mockResolvedValue([]);

      await expect(
        service.update('task-1', { assigneeIds: ['outsider'] }, admin),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('updateStatus', () => {
    it('should throw NotFoundException if the task does not belong to the company', async () => {
      (prisma.task.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        service.updateStatus(
          'task-x',
          { status: TaskStatus.DONE },
          communityManager,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('should allow an ADMIN to update the status of any task in the company', async () => {
      (prisma.task.findFirst as jest.Mock).mockResolvedValue({
        ...mockTask,
        assignees: [],
      });
      (prisma.task.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.task.findUniqueOrThrow as jest.Mock).mockResolvedValue({
        ...mockTask,
        status: TaskStatus.DONE,
        assignees: [],
      });

      const result = await service.updateStatus(
        'task-1',
        { status: TaskStatus.DONE },
        admin,
      );

      expect(prisma.task.updateMany).toHaveBeenCalledWith({
        where: { id: 'task-1', companyId: admin.companyId },
        data: { status: TaskStatus.DONE },
      });
      expect(result.status).toBe(TaskStatus.DONE);
    });

    it('should allow an assignee to update the status of their own task', async () => {
      (prisma.task.findFirst as jest.Mock).mockResolvedValue({
        ...mockTask,
        assignees: [{ taskId: 'task-1', userId: communityManager.userId }],
      });
      (prisma.task.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.task.findUniqueOrThrow as jest.Mock).mockResolvedValue({
        ...mockTask,
        status: TaskStatus.IN_PROGRESS,
        assignees: [],
      });

      await service.updateStatus(
        'task-1',
        { status: TaskStatus.IN_PROGRESS },
        communityManager,
      );

      expect(prisma.task.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'task-1',
          companyId: communityManager.companyId,
          assignees: { some: { userId: communityManager.userId } },
        },
        data: { status: TaskStatus.IN_PROGRESS },
      });
    });

    // Un COMMUNITY_MANAGER/PROVIDER assigné ne peut changer le statut que de
    // SES PROPRES tâches, pas celles des autres (spécification BACK-212).
    it('should throw ForbiddenException if a non-privileged user is not an assignee', async () => {
      (prisma.task.findFirst as jest.Mock).mockResolvedValue({
        ...mockTask,
        assignees: [{ taskId: 'task-1', userId: 'someone-else' }],
      });

      await expect(
        service.updateStatus(
          'task-1',
          { status: TaskStatus.DONE },
          communityManager,
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.task.updateMany).not.toHaveBeenCalled();
    });

    // Verrou optimiste — cas de conflit (count: 0), ex: la tâche a été
    // réassignée entre la lecture de vérification et l'écriture.
    it('should throw ConflictException when the optimistic lock fails (count: 0)', async () => {
      (prisma.task.findFirst as jest.Mock).mockResolvedValue({
        ...mockTask,
        assignees: [],
      });
      (prisma.task.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

      await expect(
        service.updateStatus('task-1', { status: TaskStatus.DONE }, admin),
      ).rejects.toThrow(ConflictException);
    });
  });
});
