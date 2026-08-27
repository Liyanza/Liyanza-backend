import { IsEmail, IsNotEmpty, IsString, IsEnum } from 'class-validator';
import { Role } from '@prisma/client';

export class CreateSubAccountDto {
  @IsEmail()
  @IsNotEmpty()
  email!: string;

  @IsString()
  @IsNotEmpty()
  firstName!: string;

  @IsString()
  @IsNotEmpty()
  lastName!: string;

  @IsString()
  @IsNotEmpty()
  phone!: string;

  @IsEnum(Role)
  @IsNotEmpty()
  role!: Role;
}
