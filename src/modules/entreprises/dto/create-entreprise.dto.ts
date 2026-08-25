import { IsNotEmpty, IsString } from 'class-validator';

export class CreateEntrepriseDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsNotEmpty()
  businessSector!: string;

  @IsString()
  @IsNotEmpty()
  address!: string;
}
