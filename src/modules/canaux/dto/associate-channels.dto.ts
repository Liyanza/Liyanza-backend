import { IsArray, ValidateNested, ArrayMinSize } from 'class-validator';
import { Type } from 'class-transformer';
import { CreateChannelsDto } from './create-channels.dto';

export class AssociateChannelsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateChannelsDto)
  channels!: CreateChannelsDto[];
}
