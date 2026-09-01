import { IsOptional, IsString, IsDateString } from 'class-validator';

export class UpdateDiffusionReelleDto {
  @IsDateString()
  @IsOptional()
  actualBroadcastAt?: string;

  @IsString()
  @IsOptional()
  audioProof?: string;
}
