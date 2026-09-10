import {
  IsArray,
  ArrayMaxSize,
  ArrayMinSize,
  ValidateNested,
  IsEnum,
  IsOptional,
} from 'class-validator';
import { Type } from 'class-transformer';
import { SocialPlatform } from '@prisma/client';
import { IsCuid } from '../../../common/validators/is-cuid.validator';

export class DigitalChannelSelectionDto {
  @IsEnum(SocialPlatform)
  platform!: SocialPlatform;

  // Optionnel : le canal peut être sélectionné avant que le compte social
  // correspondant ne soit lié (déclencheur OAuth côté mobile) — la
  // simulation dégrade proprement (métriques `null`) tant qu'aucun compte
  // n'est encore rattaché, voir `DigitalCampaignsService.createSimulation`.
  @IsOptional()
  @IsCuid()
  socialAccountId?: string;
}

/**
 * Étape 4 du formulaire : canaux de diffusion sélectionnés. Au plus un par
 * plateforme (FACEBOOK/INSTAGRAM) — la duplication est rejetée par le
 * service, pas ici (cohérence métier, pas une contrainte de forme).
 */
export class SelectDigitalChannelsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2)
  @ValidateNested({ each: true })
  @Type(() => DigitalChannelSelectionDto)
  channels!: DigitalChannelSelectionDto[];
}
