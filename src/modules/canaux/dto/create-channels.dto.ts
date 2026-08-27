import { IsBoolean } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateChannelsDto {
  @IsBoolean()
  @Type(() => Boolean)
  radio!: boolean;

  @IsBoolean()
  @Type(() => Boolean)
  poster!: boolean;

  @IsBoolean()
  @Type(() => Boolean)
  flyer!: boolean;
}
