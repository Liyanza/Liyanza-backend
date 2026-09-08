import { IsOptional, IsDateString, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { IsCuid } from '../../../common/validators/is-cuid.validator';

export class ScheduleQueryDto {
  // CORRECTIF AUDIT : était `@IsUUID()` — le filtre par canal était donc
  // inutilisable, tout `?channelId=...` valide étant rejeté en 400.
  @IsOptional()
  @IsCuid()
  channelId?: string;

  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}
