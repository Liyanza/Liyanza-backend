import {
  IsEnum,
  IsString,
  IsNotEmpty,
  IsUrl,
  IsOptional,
  MaxLength,
} from 'class-validator';
import { QrCodeTargetType } from '@prisma/client';
import { IsCuid } from '../../../common/validators/is-cuid.validator';

export class CreateQrCodeDto {
  @IsEnum(QrCodeTargetType)
  targetType!: QrCodeTargetType;

  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(2048)
  targetUrl!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  zone!: string;

  @IsOptional()
  @IsCuid()
  installationId?: string;
}
