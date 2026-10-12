import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsDefined,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  ValidateNested,
} from 'class-validator';
import { BillingPeriod, PlanTier } from '@prisma/client';

export class CheckoutPhoneDto {
  /** Numéro sans indicatif ni espaces : Chariow l'exige pour le Mobile Money. */
  @ApiProperty({ example: '690000000' })
  @IsString()
  @Matches(/^\d{6,15}$/, {
    message: 'phone.number must contain 6 to 15 digits only.',
  })
  number!: string;

  @ApiProperty({ example: 'CM', required: false, default: 'CM' })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{2}$/, {
    message: 'phone.countryCode must be an ISO 3166-1 alpha-2 code.',
  })
  countryCode?: string;
}

export class CreateCheckoutDto {
  @ApiProperty({ enum: PlanTier })
  @IsEnum(PlanTier)
  plan!: PlanTier;

  @ApiProperty({ enum: BillingPeriod })
  @IsEnum(BillingPeriod)
  period!: BillingPeriod;

  @ApiProperty({ type: CheckoutPhoneDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => CheckoutPhoneDto)
  phone!: CheckoutPhoneDto;

  /** Code de réduction créé dans la boutique Chariow, appliqué au paiement. */
  @ApiProperty({ example: 'LANCEMENT20', required: false })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  @IsString()
  @Matches(/^[\w-]{1,100}$/, {
    message: 'discountCode must contain letters, digits, - or _ only.',
  })
  discountCode?: string;
}
