import {
  IsString,
  IsNotEmpty,
  IsDateString,
  IsInt,
  Min,
  IsUUID,
  IsArray,
  ValidateNested,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';

export class BroadcastEntryDto {
  @IsString()
  @IsNotEmpty()
  mediaType!: string; // e.g., "radio", "poster", "flyer"

  @IsDateString()
  scheduledAt!: string; // ISO date string

  @IsInt()
  @Min(1)
  duration!: number; // duration in seconds

  @IsUUID()
  channelId!: string; // ID of an existing channel linked to the campaign
}

export class CreateScheduleDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BroadcastEntryDto)
  broadcasts!: BroadcastEntryDto[];
}
