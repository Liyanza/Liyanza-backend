import {
  IsNotEmpty,
  IsString,
  IsOptional,
  IsEnum,
  MaxLength,
} from 'class-validator';

/**
 * Statuts possibles d'une installation terrain.
 *
 * CORRECTIF AUDIT (majeur — corruption du modèle de données) :
 * `UpdateStatusDto.status` était un `@IsString()` libre. `PATCH
 * /prestations/:id/statut` acceptait donc n'importe quelle chaîne, écrite
 * telle quelle dans `Installation.status` (colonne `String` non contrainte
 * dans `prisma/schema.prisma`). Or ce champ est comparé littéralement à
 * `'INSTALLED'` dans `StatistiquesService.getDashboard` (taux d'installation)
 * et `generateRapport` : un simple `{"status":"installed"}` — casse
 * différente — suffisait à faire disparaître silencieusement l'installation
 * des indicateurs, sans aucune erreur.
 *
 * NOTE : la contrainte est ici posée au niveau applicatif uniquement. La
 * migration du schéma Prisma (`String` -> `enum InstallationStatus`) est
 * recommandée mais nécessite une migration de données sur les lignes
 * existantes — voir le plan d'action de l'audit.
 */
export enum InstallationStatus {
  PLANNED = 'PLANNED',
  IN_PROGRESS = 'IN_PROGRESS',
  INSTALLED = 'INSTALLED',
  VALIDATED = 'VALIDATED',
  REJECTED = 'REJECTED',
  CANCELLED = 'CANCELLED',
}

export class UpdateStatusDto {
  @IsEnum(InstallationStatus)
  @IsNotEmpty()
  status!: InstallationStatus;

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  comment?: string;
}
