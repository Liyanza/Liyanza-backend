import { IsDateString, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { IsCuid } from '../../../common/validators/is-cuid.validator';

/**
 * Payload du webhook interne de monitoring radio (BACK-304). Ne modélise
 * QUE le résultat d'une détection déjà effectuée par le futur service
 * `Liyanza-ia` — ce dépôt n'implémente jamais l'analyse audio elle-même,
 * voir `.claude/skills/liyanza-ia-boundary/SKILL.md`.
 */
export class RecordDetectionDto {
  @IsCuid()
  diffusionId!: string;

  @IsDateString()
  @IsNotEmpty()
  detectedAt!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  audioProof!: string;
}
