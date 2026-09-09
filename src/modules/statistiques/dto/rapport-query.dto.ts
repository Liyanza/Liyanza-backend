import { IsOptional, IsIn } from 'class-validator';
import { IsCuid } from '../../../common/validators/is-cuid.validator';

export class RapportQueryDto {
  @IsIn(['csv', 'pdf'])
  format!: 'csv' | 'pdf';

  @IsOptional()
  @IsCuid()
  campagneId?: string;
}
