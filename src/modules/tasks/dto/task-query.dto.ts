import { IsOptional, IsEnum } from 'class-validator';
import { TaskStatus } from '@prisma/client';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { IsCuid } from '../../../common/validators/is-cuid.validator';

/**
 * Query string de `GET /tasks`.
 *
 * Tous les filtres sont déclarés sur ce DTO (qui étend `PaginationQueryDto`)
 * plutôt qu'en `@Query('champ')` séparés : la `ValidationPipe` globale
 * (`forbidNonWhitelisted: true`) rejetterait sinon la requête en 400 — voir
 * `.claude/skills/liyanza-nestjs-module/SKILL.md`.
 */
export class TaskQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(TaskStatus)
  status?: TaskStatus;

  @IsOptional()
  @IsCuid()
  assigneeId?: string;
}
