import {
  IsNotEmpty,
  IsDateString,
  IsInt,
  Min,
  Max,
  IsArray,
  ValidateNested,
  ArrayMinSize,
  ArrayMaxSize,
  IsEnum,
} from 'class-validator';
import { Type } from 'class-transformer';
import { IsCuid } from '../../../common/validators/is-cuid.validator';

/**
 * Supports de diffusion autorisés.
 *
 * CORRECTIF AUDIT (majeur) : `mediaType` était un `@IsString()` libre, alors
 * qu'il est comparé et agrégé ailleurs dans l'application. N'importe quelle
 * chaîne (y compris un texte de 10 Mo) était persistée, corrompant les
 * statistiques et les rapports de conformité.
 */
export enum MediaType {
  RADIO = 'RADIO',
  POSTER = 'POSTER',
  FLYER = 'FLYER',
}

/** Durée maximale d'une diffusion unitaire : 24 h, en secondes. */
const MAX_BROADCAST_DURATION_SECONDS = 86_400;

export class BroadcastEntryDto {
  @IsEnum(MediaType)
  @IsNotEmpty()
  mediaType!: MediaType;

  @IsDateString()
  scheduledAt!: string; // ISO date string

  @IsInt()
  @Min(1)
  @Max(MAX_BROADCAST_DURATION_SECONDS)
  duration!: number; // duration in seconds

  // CORRECTIF AUDIT (faille critique) : était `@IsUUID()`, incompatible avec
  // les identifiants cuid générés par Prisma — l'endpoint renvoyait 400 dans
  // 100 % des cas. Voir `IsCuid` pour le détail.
  @IsCuid()
  channelId!: string;
}

export class CreateScheduleDto {
  @IsArray()
  @ArrayMinSize(1)
  // CORRECTIF AUDIT (majeur — DoS) : sans borne haute, une seule requête
  // pouvait soumettre un tableau arbitrairement grand, chaque entrée
  // déclenchant un `INSERT` au sein d'une même transaction Prisma.
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => BroadcastEntryDto)
  broadcasts!: BroadcastEntryDto[];
}
