import {
  IsNotEmpty,
  IsString,
  IsDateString,
  IsNumber,
  Min,
  Max,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Borne haute du budget planifié.
 *
 * CORRECTIF AUDIT (majeur) : la colonne cible est
 * `plannedBudget Decimal @db.Decimal(12, 2)` (prisma/schema.prisma), soit un
 * maximum absolu de 9 999 999 999,99. Aucune borne haute n'existait côté DTO
 * ni côté service : `{"plannedBudget": 1e15}` était accepté par la validation,
 * transmis à Prisma, et rejeté par PostgreSQL avec une erreur `numeric field
 * overflow` — remontée en 500 accompagnée du message brut décrivant la colonne
 * et sa précision. On borne en deçà de la capacité de la colonne.
 */
export const MAX_PLANNED_BUDGET = 9_999_999_999;

export class CreateCampagneDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsDateString()
  @IsNotEmpty()
  startDate!: string;

  @IsDateString()
  @IsNotEmpty()
  endDate!: string;

  // `maxDecimalPlaces: 2` aligne la validation sur la précision réelle de la
  // colonne : au-delà, PostgreSQL arrondit silencieusement, ce qui provoque
  // des écarts de centimes inexpliqués sur les rapports budgétaires.
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(MAX_PLANNED_BUDGET)
  @Type(() => Number)
  plannedBudget!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  objective!: string;
}
