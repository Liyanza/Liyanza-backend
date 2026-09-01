import {
  IsArray,
  ValidateNested,
  IsNotEmpty,
  IsUUID,
  IsString,
} from 'class-validator';
import { Type } from 'class-transformer';

class ReponseDto {
  @IsUUID()
  @IsNotEmpty()
  questionId!: string;

  @IsString()
  @IsNotEmpty()
  value!: string;
}

export class SoumettreReponsesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReponseDto)
  reponses!: ReponseDto[];
}
