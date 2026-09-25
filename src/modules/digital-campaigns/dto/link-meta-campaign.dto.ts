import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class LinkMetaCampaignDto {
  @ApiProperty({
    description: 'Identifiant de la campagne Facebook Ads (Meta)',
    example: '120210000000000000',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^\d{1,30}$/, {
    message: 'metaCampaignId must be a Meta campaign id.',
  })
  metaCampaignId!: string;
}
