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

  @ApiProperty({
    description:
      'Distance in meters between the planned installation location and the submitted proof location (Haversine)',
  })
  distanceMeters!: number;

  @ApiProperty({
    description:
      'Whether the proof location is within the acceptable tolerance of the planned location',
  })
  locationMatch!: boolean;

  constructor(partial: Partial<ValidationConsultationResponseDto>) {
    Object.assign(this, partial);
  }
}
