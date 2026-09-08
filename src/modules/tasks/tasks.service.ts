import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { assertSameCompany } from '../auth/utils/company-scope.util';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { UpdateTaskStatusDto } from './dto/update-task-status.dto';
import { TaskQueryDto } from './dto/task-query.dto';

const assigneeInclude = {
  assignees: {
    include: {
      user: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          role: true,
        },
      },
    },
  },
} satisfies Prisma.TaskInclude;

@Injectable()
export class TasksService {
  constructor(private prisma: PrismaService) {}

  private requireCompany(user: AuthenticatedUser): string {
    if (!user.companyId) {
      throw new ForbiddenException(
        'Vous devez appartenir à une entreprise pour gérer les tâches.',
      );
    }
    return user.companyId;
  }

  private async assertCampaignInCompany(
    campaignId: string,
    user: AuthenticatedUser,
  ): Promise<void> {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      include: { launchedBy: true },
    });
    if (!campaign) {
      throw new NotFoundException('Campagne introuvable.');
    }
    assertSameCompany(user, campaign.launchedBy.companyId, 'Campagne');
  }

  private async assertAssigneesInCompany(
    assigneeIds: string[],
    companyId: string,
  ): Promise<void> {
    const uniqueIds = new Set(assigneeIds);
    const found = await this.prisma.user.findMany({
      where: { id: { in: [...uniqueIds] }, companyId },
      select: { id: true },
    });
    if (found.length !== uniqueIds.size) {
      throw new BadRequestException(
        "Un ou plusieurs assignés sont introuvables ou n'appartiennent pas à votre entreprise.",
      );
    }
  }

  async create(dto: CreateTaskDto, user: AuthenticatedUser) {
    const companyId = this.requireCompany(user);

    if (dto.campaignId) {
      await this.assertCampaignInCompany(dto.campaignId, user);
    }
    await this.assertAssigneesInCompany(dto.assigneeIds, companyId);

    const taskId = await this.prisma.$transaction(async (tx) => {
      const task = await tx.task.create({
        data: {
          title: dto.title,
          description: dto.description,
          dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
          companyId,
          createdById: user.userId,
          campaignId: dto.campaignId,
        },
      });

      await tx.taskAssignee.createMany({
        data: [...new Set(dto.assigneeIds)].map((userId) => ({
          taskId: task.id,
          userId,
        })),
      });

      return task.id;
    });

    return this.prisma.task.findUniqueOrThrow({
      where: { id: taskId },
      include: assigneeInclude,
    });
  }

  async findAll(query: TaskQueryDto, user: AuthenticatedUser) {
    const companyId = this.requireCompany(user);

    const where: Prisma.TaskWhereInput = { companyId };
    if (query.status) {
      where.status = query.status;
    }
    if (query.assigneeId) {
      where.assignees = { some: { userId: query.assigneeId } };
    }

    const limit = query.limit ?? 10;
    const page = query.page ?? 1;
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      this.prisma.task.findMany({
        where,
        include: assigneeInclude,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip,
      }),
      this.prisma.task.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findOne(id: string, user: AuthenticatedUser) {
    const companyId = this.requireCompany(user);

    const task = await this.prisma.task.findFirst({
      where: { id, companyId },
      include: assigneeInclude,
    });
    if (!task) {
      throw new NotFoundException('Tâche introuvable.');
    }
    return task;
  }

  async update(id: string, dto: UpdateTaskDto, user: AuthenticatedUser) {
    const companyId = this.requireCompany(user);

    const existing = await this.prisma.task.findFirst({
      where: { id, companyId },
    });
    if (!existing) {
      throw new NotFoundException('Tâche introuvable.');
    }

    if (dto.campaignId) {
      await this.assertCampaignInCompany(dto.campaignId, user);
    }
    if (dto.assigneeIds) {
      await this.assertAssigneesInCompany(dto.assigneeIds, companyId);
    }

    await this.prisma.$transaction(async (tx) => {
      // CORRECTIF (garde-fou multi-tenant) : on réaffirme `companyId` dans le
      // `where` de l'écriture (updateMany), pas uniquement lors de la lecture
      // préalable — voir .claude/skills/liyanza-security-guardrails/SKILL.md §2.
      const result = await tx.task.updateMany({
        where: { id, companyId },
        data: {
          title: dto.title,
          description: dto.description,
          dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
          campaignId: dto.campaignId,
        },
      });
      if (result.count === 0) {
        throw new ConflictException(
          'La tâche a changé entre-temps, réessayez.',
        );
      }

      if (dto.assigneeIds) {
        await tx.taskAssignee.deleteMany({ where: { taskId: id } });
        await tx.taskAssignee.createMany({
          data: [...new Set(dto.assigneeIds)].map((userId) => ({
            taskId: id,
            userId,
          })),
        });
      }
    });

    return this.prisma.task.findUniqueOrThrow({
      where: { id },
      include: assigneeInclude,
    });
  }

  async updateStatus(
    id: string,
    dto: UpdateTaskStatusDto,
    user: AuthenticatedUser,
  ) {
    const companyId = this.requireCompany(user);

    const task = await this.prisma.task.findFirst({
      where: { id, companyId },
      include: { assignees: true },
    });
    if (!task) {
      throw new NotFoundException('Tâche introuvable.');
    }

    const isPrivileged =
      user.role === Role.ADMIN || user.role === Role.MARKETING_MANAGER;
    const isAssignee = task.assignees.some((a) => a.userId === user.userId);
    if (!isPrivileged && !isAssignee) {
      throw new ForbiddenException(
        'Vous ne pouvez modifier que le statut des tâches qui vous sont assignées.',
      );
    }

    // Verrou optimiste : combine la vérification de portée (entreprise +,
    // pour un non-privilégié, appartenance à assignees) et l'écriture en une
    // seule opération atomique, plutôt qu'un `findFirst` puis `update`
    // séparés — voir .claude/skills/liyanza-security-guardrails/SKILL.md §6.
    const where: Prisma.TaskWhereInput = isPrivileged
      ? { id, companyId }
      : { id, companyId, assignees: { some: { userId: user.userId } } };

    const result = await this.prisma.task.updateMany({
      where,
      data: { status: dto.status },
    });
    if (result.count === 0) {
      throw new ConflictException('La tâche a changé entre-temps, réessayez.');
    }

    return this.prisma.task.findUniqueOrThrow({
      where: { id },
      include: assigneeInclude,
    });
  }
}
