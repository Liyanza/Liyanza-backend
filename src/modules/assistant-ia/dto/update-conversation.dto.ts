import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class UpdateConversationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  topic!: string;
}
