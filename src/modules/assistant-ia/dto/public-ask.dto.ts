import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/** Limites alignées sur le mode `public` du service chatbot (`chatbot_api.py`). */
export const PUBLIC_MESSAGE_MAX_LENGTH = 500;
export const PUBLIC_HISTORY_MAX_MESSAGES = 4;

export class PublicHistoryMessageDto {
  @IsIn(['USER', 'AI'])
  sender!: 'USER' | 'AI';

  @IsString()
  @MaxLength(2000)
  content!: string;
}

/**
 * Question d'un visiteur anonyme du site vitrine. Rien n'est enregistré en
 * base : l'historique de la session vit dans le navigateur du visiteur, qui
 * le renvoie ici (4 messages au plus).
 */
export class PublicAskDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(PUBLIC_MESSAGE_MAX_LENGTH)
  message!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(PUBLIC_HISTORY_MAX_MESSAGES)
  @ValidateNested({ each: true })
  @Type(() => PublicHistoryMessageDto)
  history?: PublicHistoryMessageDto[];
}
