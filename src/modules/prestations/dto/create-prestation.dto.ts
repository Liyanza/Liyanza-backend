import {
  IsNotEmpty,
  IsString,
  IsNumber,
  IsDateString,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';
import { IsCuid } from '../../../common/validators/is-cuid.validator';

export class CreatePrestationDto {
  @IsString()
  @IsNotEmpty()
  location!: string;

  /**
   * CORRECTIF (écart fonctionnel majeur — endpoint mort) : absent jusqu'ici,
   * `providerId` était donc toujours implicitement celui du créateur
   * (ADMIN/MARKETING_MANAGER). Or `POST /prestations/:id/preuve` exige à la
   * fois le rôle PROVIDER (`@Roles(Role.PROVIDER)`) ET
   * `installation.providerId === user.userId` — un ADMIN/MARKETING_MANAGER
   * ne peut jamais avoir le rôle PROVIDER, donc aucun PROVIDER ne pouvait
   * jamais satisfaire les deux conditions à la fois. Obligatoire (pas de
   * repli implicite sur le créateur, qui préserverait le bug pour tout
   * appelant qui l'omettrait) — voir `PrestationsService.createPrestation`
   * pour la validation (existence, même entreprise, rôle PROVIDER).
   */
  @IsCuid()
  providerId!: string;

  @IsNumber()
  @Min(-90)
  @Max(90)
  @Type(() => Number)
  plannedLatitude!: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  @Type(() => Number)
  plannedLongitude!: number;

  @IsDateString()
  @IsNotEmpty()
  plannedInstallationDate!: string;
}
