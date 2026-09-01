import { IsOptional, IsString, IsIn } from 'class-validator';

export class RapportQueryDto {
  @IsIn(['csv', 'pdf'])
  format!: 'csv' | 'pdf';

  @IsOptional()
  @IsString()
  campagneId?: string;
}
