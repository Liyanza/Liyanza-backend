import { IsEnum, IsOptional } from 'class-validator';
import { CampaignStatus, CampaignType } from '@prisma/client';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

/**
 * Query string de `GET /campagnes`.
 *
 * CORRECTIF AUDIT (faille critique — filtre inopérant) : le contrôleur
 * combinait `@Query() { page, limit }: PaginationQueryDto` avec un
 * `@Query('status')` séparé. Or `@Query()` sans clé fait valider l'objet
 * query COMPLET contre `PaginationQueryDto`, et la `ValidationPipe` globale
 * (`src/main.ts`) est configurée avec `forbidNonWhitelisted: true`. Toute
 * requête `GET /campagnes?status=DRAFT` était donc rejetée en 400
 * « property status should not exist » : le filtre documenté était
 * strictement inutilisable.
 *
 * Vérifié sur le JavaScript compilé : `dist/src/modules/campagnes/
 * campagnes.controller.js` émet bien
 * `design:paramtypes = [Object, PaginationQueryDto, String, String]`.
 *
 * Déclarer tous les paramètres dans un DTO unique règle le problème à la
 * racine et rend le contrat d'API explicite.
 */
export class CampagneQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(CampaignStatus)
  status?: CampaignStatus;

  // ← BACK-501 : permet au wizard mobile de lister uniquement les campagnes
  // digitales (ou l'inverse), même principe que le filtre `status` ci-dessus.
  @IsOptional()
  @IsEnum(CampaignType)
  type?: CampaignType;
}
