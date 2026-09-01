import {
  IsNotEmpty,
  IsString,
  IsNumber,
  IsDateString,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreatePrestationDto {
  @IsString()
  @IsNotEmpty()
  location!: string;

  @IsNumber()
  @Min(-90)
  @Max(90)
  @Type(() => Number)
  plannedLatitude!: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  @Type(() => Number)
  plannedLongitude!: number;

  @IsDateString()
  @IsNotEmpty()
  plannedInstallationDate!: string;
}
