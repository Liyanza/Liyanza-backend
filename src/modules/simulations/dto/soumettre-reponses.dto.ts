import {
  IsArray,
  ValidateNested,
  IsNotEmpty,
  IsString,
  MaxLength,
  ArrayMinSize,
  ArrayMaxSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { IsCuid } from '../../../common/validators/is-cuid.validator';

class ReponseDto {
  // CORRECTIF AUDIT (faille critique) : était `@IsUUID()`. Les `Question.id`
  // sont des cuid (`prisma/schema.prisma`, modèle `Question`), jamais des
  // UUID — `POST /campagnes/:id/simulations` renvoyait donc 400 quelles que
  // soient les réponses soumises.
  @IsCuid()
  @IsNotEmpty()
  questionId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  value!: string;
}

export class SoumettreReponsesDto {
  @IsArray()
  // CORRECTIF AUDIT : un tableau vide créait un `Questionnaire` orphelin sans
  // aucune réponse, puis une `Simulation` calculée sur rien.
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ReponseDto)
  reponses!: ReponseDto[];
}
