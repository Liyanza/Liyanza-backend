import {
  IsEnum,
  IsIn,
  IsInt,
  Min,
  Max,
  IsArray,
  ArrayMaxSize,
  IsString,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { BudgetAllocationType, DigitalObjective } from '@prisma/client';

/**
 * Étapes 1-3 du formulaire de création d'une campagne digitale (objectif,
 * audience, budget) — voir `DigitalCampaignsService.upsertDetails`.
 */
export class UpsertDigitalDetailsDto {
  @IsEnum(DigitalObjective)
  objective!: DigitalObjective;

  // 13 ans : âge minimum autorisé par les CGU Meta Ads pour le ciblage
  // publicitaire — reflète une contrainte de la plateforme cible, pas un
  // choix arbitraire de ce repo.
  @IsInt()
  @Min(13)
  @Max(65)
  @Type(() => Number)
  ageMin!: number;

  @IsInt()
  @Min(13)
  @Max(65)
  @Type(() => Number)
  ageMax!: number;

  @IsIn(['ALL', 'MALE', 'FEMALE'])
  targetGender!: string;

  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  targetLocations!: string[];

  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  targetInterests!: string[];

  @IsEnum(BudgetAllocationType)
  budgetAllocation!: BudgetAllocationType;
}
