import { IsEnum, IsNotEmpty } from 'class-validator';
import { CampaignStatus } from '@prisma/client';

export class LancerCampagneDto {
  @IsEnum(CampaignStatus)
  @IsNotEmpty()
  status!: CampaignStatus;
}
