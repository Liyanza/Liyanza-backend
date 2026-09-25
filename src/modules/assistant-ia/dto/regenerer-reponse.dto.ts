import { IsOptional } from 'class-validator';
import { IsCuid } from '../../../common/validators/is-cuid.validator';

export class RegenererReponseDto {
  /** Même rôle que `EnvoyerMessageDto.campaignId`. */
  @IsOptional()
  @IsCuid()
  campaignId?: string;
}
