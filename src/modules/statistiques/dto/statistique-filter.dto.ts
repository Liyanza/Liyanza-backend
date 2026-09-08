import {
  IsOptional,
  IsString,
  IsDateString,
  IsInt,
  Min,
  Max,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export class StatistiqueFilterDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  indicator?: string;

  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number = 0;

  // CORRECTIF AUDIT (majeur — DoS) : `@Min(1)` sans borne haute laissait
  // passer `?limit=1000000`, transmis tel quel à `take:` dans
  // `StatistiquesService.getCampagneStatistiques`. Une seule requête pouvait
  // donc rapatrier l'intégralité de la table `Statistic`.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number = 100;
}
