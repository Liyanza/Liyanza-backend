import { IsEnum, IsOptional } from 'class-validator';
import { SocialPlatform } from '@prisma/client';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

export class SocialAccountQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(SocialPlatform)
  platform?: SocialPlatform;
}
