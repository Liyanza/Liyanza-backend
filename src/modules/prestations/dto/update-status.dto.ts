import { IsNotEmpty, IsString, IsOptional } from 'class-validator';

export class UpdateStatusDto {
  @IsString()
  @IsNotEmpty()
  status!: string;

  @IsString()
  @IsOptional()
  comment?: string;
}
