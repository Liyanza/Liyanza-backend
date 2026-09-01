import {
  IsNotEmpty,
  IsString,
  IsNumber,
  IsDateString,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';

export class SoumettrePreuveDto {
  @IsString()
  @IsNotEmpty()
  photo!: string; // URL or reference to the stored photo

  @IsNumber()
  @Min(-90)
  @Max(90)
  @Type(() => Number)
  latitude!: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  @Type(() => Number)
  longitude!: number;

  @IsDateString()
  @IsNotEmpty()
  takenAt!: string; // ISO date string
}
