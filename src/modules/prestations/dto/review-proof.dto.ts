import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export const PROOF_DECISIONS = ['VALIDATED', 'REJECTED'] as const;
export type ProofDecision = (typeof PROOF_DECISIONS)[number];

/**
 * Décision de l'entreprise sur une preuve d'installation reçue
 * (`PATCH /prestations/:id/preuve/validation`).
 */
export class ReviewProofDto {
  @ApiProperty({ enum: PROOF_DECISIONS })
  @IsIn(PROOF_DECISIONS)
  decision!: ProofDecision;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;
}
