import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { DigitalObjective } from '@prisma/client';

export class DescribeCampaignDto {
  @ApiProperty({ example: 'Promo rentrée' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @ApiProperty({ example: 'Nettoyage de canapés à domicile' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  product!: string;

  @ApiPropertyOptional({ enum: DigitalObjective })
  @IsOptional()
  @IsEnum(DigitalObjective)
  objective?: DigitalObjective;
}
