import { ApiProperty } from '@nestjs/swagger';

export class ValidationConsultationResponseDto {
  @ApiProperty({ description: 'Installation location' })
  location!: string;

  @ApiProperty({ description: 'Proof photo URL' })
  photo!: string;

  @ApiProperty({ description: 'Proof latitude' })
  latitude!: number;

  @ApiProperty({ description: 'Proof longitude' })
  longitude!: number;

  @ApiProperty({ description: 'When the proof photo was taken (ISO)' })
  takenAt!: string;

  @ApiProperty({ description: 'Current validation status of the proof' })
  validationStatus!: string;

  @ApiProperty({
    description: 'Comment left at validation time, if any',
    required: false,
  })
  validationComment?: string | null;

  constructor(partial: Partial<ValidationConsultationResponseDto>) {
    Object.assign(this, partial);
  }
}
