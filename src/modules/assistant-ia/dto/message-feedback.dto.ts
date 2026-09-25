import { IsEnum, IsOptional } from 'class-validator';
import { AiMessageFeedback } from '@prisma/client';

export class MessageFeedbackDto {
  /** `UP` / `DOWN`, ou `null` pour retirer l'avis. */
  @IsOptional()
  @IsEnum(AiMessageFeedback)
  value!: AiMessageFeedback | null;
}
