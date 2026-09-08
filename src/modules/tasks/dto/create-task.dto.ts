import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsDateString,
  IsArray,
  ArrayNotEmpty,
  ArrayUnique,
  Matches,
} from 'class-validator';
import {
  IsCuid,
  CUID_REGEX,
} from '../../../common/validators/is-cuid.validator';

export class CreateTaskDto {
  @IsString()
  @IsNotEmpty()
  title!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @IsOptional()
  @IsCuid()
  campaignId?: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsString({ each: true })
  @Matches(CUID_REGEX, {
    each: true,
    message:
      'each value in assigneeIds must be a valid resource identifier (cuid)',
  })
  assigneeIds!: string[];
}
