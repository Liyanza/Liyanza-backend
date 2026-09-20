import { ApiProperty } from '@nestjs/swagger';

/**
 * Ce que voit le prestataire externe (sans compte) en ouvrant son lien de
 * preuve, AVANT de soumettre quoi que ce soit — juste assez pour confirmer
 * qu'il est au bon endroit, jamais de donnée sensible sur l'entreprise.
 */
export class ProofLinkConsultationResponseDto {
  @ApiProperty({ description: 'Human-readable installation location' })
  location!: string;

  @ApiProperty({ description: 'Campaign name this installation belongs to' })
  campaignName!: string;

  @ApiProperty({ description: 'Planned installation date (ISO)' })
  plannedInstallationDate!: string;

  @ApiProperty({
    description:
      'Whether a proof has already been submitted for this installation',
  })
  alreadySubmitted!: boolean;

  constructor(partial: Partial<ProofLinkConsultationResponseDto>) {
    Object.assign(this, partial);
  }
}
