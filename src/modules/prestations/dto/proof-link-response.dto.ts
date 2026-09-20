import { ApiProperty } from '@nestjs/swagger';

export class ProofLinkResponseDto {
  @ApiProperty({
    description: 'The full proof-submission link (no account required)',
  })
  link!: string;

  @ApiProperty({ description: 'The JWT token (single-use)' })
  token!: string;

  @ApiProperty({ description: 'Token expiration date (ISO)' })
  expiresAt!: string;

  constructor(partial: Partial<ProofLinkResponseDto>) {
    Object.assign(this, partial);
  }
}
