import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { IsCuid } from '../../../common/validators/is-cuid.validator';

export class EnvoyerMessageDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  content!: string;

  /**
   * Campagne affichée à l'écran quand la question est posée depuis le
   * Copilot : ses données sont ajoutées au contexte envoyé à l'IA. Vérifiée
   * dans le périmètre de l'entreprise de l'utilisateur (404 sinon).
   */
  @IsOptional()
  @IsCuid()
  campaignId?: string;
}
