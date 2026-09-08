import { applyDecorators } from '@nestjs/common';
import { IsString, Matches, MaxLength } from 'class-validator';

/**
 * Valide un identifiant tel que généré par Prisma (`@default(cuid())`).
 *
 * CORRECTIF AUDIT (faille critique — endpoints morts) : plusieurs DTO
 * validaient des identifiants de ressources avec `@IsUUID()`. Or AUCUN
 * identifiant de ce projet n'est un UUID : `prisma/schema.prisma` déclare
 * `@id @default(cuid())` sur tous les modèles. Un cuid v1 (`c` + 24 caractères
 * base36, ex. `clx3k9q1a0000t8p2h4v6d1e5`) ne satisfait jamais le format
 * UUID (8-4-4-4-12 hexadécimal). Résultat : la `ValidationPipe` rejetait
 * systématiquement ces requêtes en 400, rendant trois fonctionnalités
 * totalement inatteignables en production :
 *   - `POST /campagnes/:id/planning`      (BroadcastEntryDto.channelId)
 *   - `POST /campagnes/:id/simulations`   (ReponseDto.questionId)
 *   - `GET  /campagnes/:id/planning?channelId=` (ScheduleQueryDto.channelId)
 *
 * On accepte ici le format cuid v1 et cuid2 (ce dernier étant le défaut des
 * versions récentes de Prisma), en restant volontairement permissif sur la
 * longueur pour ne pas casser à la prochaine montée de version — la garantie
 * d'existence reste apportée par la base, pas par le validateur.
 */
export const CUID_REGEX = /^[a-z][a-z0-9]{7,31}$/;

export function IsCuid(): PropertyDecorator {
  return applyDecorators(
    IsString(),
    MaxLength(64),
    Matches(CUID_REGEX, {
      message: '$property must be a valid resource identifier (cuid)',
    }),
  );
}
