import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ConsommerValidationDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  commentaire?: string;
}
