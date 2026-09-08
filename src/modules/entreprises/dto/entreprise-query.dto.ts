import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

/**
 * Query string de `GET /entreprises`.
 *
 * CORRECTIF AUDIT (faille critique — filtres inopérants) : même cause que
 * `CampagneQueryDto`. `?name=` et `?businessSector=` étaient rejetés en 400
 * par `forbidNonWhitelisted`, ces propriétés n'étant pas déclarées sur
 * `PaginationQueryDto`.
 */
export class EntrepriseQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  businessSector?: string;
}
