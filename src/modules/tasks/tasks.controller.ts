import {
  Controller,
  Post,
  Get,
  Patch,
  Param,
  Body,
  Query,
  Request,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Request as ExpressRequest } from 'express';
import { Role } from '@prisma/client';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { TasksService } from './tasks.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { UpdateTaskStatusDto } from './dto/update-task-status.dto';
import { TaskQueryDto } from './dto/task-query.dto';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Roles } from '../auth/decorators/roles.decorator';

interface AuthenticatedRequest extends ExpressRequest {
  user: AuthenticatedUser;
}

@ApiTags('tasks')
@Controller('tasks')
export class TasksController {
  constructor(private readonly tasksService: TasksService) {}

  @Post()
  @Roles(Role.ADMIN, Role.MARKETING_MANAGER)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a task and assign it to one or more collaborators',
  })
  @ApiResponse({ status: 201, description: 'Task created' })
  async create(
    @Body() dto: CreateTaskDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.tasksService.create(dto, req.user);
  }

  /**
   * Pas de `@Roles(...)` ici : la liste des tâches est un endpoint transverse
   * (tout utilisateur authentifié voit les tâches de son entreprise), au même
   * titre que `GET /notifications` — voir
   * .claude/skills/liyanza-nestjs-module/SKILL.md.
   */
  @Get()
  @ApiOperation({ summary: 'List company tasks (paginated, filterable)' })
  @ApiResponse({ status: 200, description: 'Paginated task list' })
  async findAll(
    @Query() query: TaskQueryDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.tasksService.findAll(query, req.user);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get task detail' })
  @ApiResponse({ status: 200, description: 'Task detail' })
  async findOne(@Param('id') id: string, @Request() req: AuthenticatedRequest) {
    return this.tasksService.findOne(id, req.user);
  }

  @Patch(':id')
  @Roles(Role.ADMIN, Role.MARKETING_MANAGER)
  @ApiOperation({
    summary: 'Update task metadata (title, description, due date, assignees)',
  })
  @ApiResponse({ status: 200, description: 'Task updated' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateTaskDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.tasksService.update(id, dto, req.user);
  }

  /**
   * Pas de `@Roles(...)` ici non plus : accessible à tout utilisateur
   * authentifié, la restriction (assigné vs privilégié) est appliquée en
   * service — voir `TasksService.updateStatus`.
   */
  @Patch(':id/statut')
  @ApiOperation({
    summary: 'Update task status (any assignee, or ADMIN/MARKETING_MANAGER)',
  })
  @ApiResponse({ status: 200, description: 'Task status updated' })
  async updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateTaskStatusDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.tasksService.updateStatus(id, dto, req.user);
  }
}
