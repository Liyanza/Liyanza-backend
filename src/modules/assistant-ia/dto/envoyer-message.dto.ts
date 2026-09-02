import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class EnvoyerMessageDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  content!: string;
}
