import {
  IsNotEmpty,
  IsString,
  IsDateString,
  IsNumber,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateCampagneDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsDateString()
  @IsNotEmpty()
  startDate!: string;

  @IsDateString()
  @IsNotEmpty()
  endDate!: string;

  @IsNumber()
  @Min(0.01)
  @Type(() => Number)
  plannedBudget!: number;

  @IsString()
  @IsNotEmpty()
  objective!: string;
}
