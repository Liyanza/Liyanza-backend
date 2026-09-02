import { ApiProperty } from '@nestjs/swagger';

export class ValidationLinkResponseDto {
  @ApiProperty({ description: 'The full validation link' })
  link!: string;

  @ApiProperty({ description: 'The JWT token (single-use)' })
  token!: string;

  @ApiProperty({ description: 'Token expiration date (ISO)' })
  expiresAt!: string;

  constructor(partial: Partial<ValidationLinkResponseDto>) {
    Object.assign(this, partial);
  }
}
