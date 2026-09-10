import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Query string du callback OAuth public (`GET /social-accounts/oauth/callback`).
 * Validée comme tout DTO (`forbidNonWhitelisted` global) — `code`/`state`
 * sont les SEULES données de cette requête auxquelles on fait confiance, et
 * uniquement pour aller chercher le contexte réel (userId/companyId/platform)
 * dans Redis via `state` : jamais de champ d'identité lu depuis la query
 * string elle-même.
 *
 * `code` est optionnel : si l'utilisateur refuse le consentement dans la
 * boîte de dialogue Meta, celle-ci redirige avec `error`/`error_description`
 * et SANS `code` — un cas attendu à traiter proprement, pas une requête
 * malformée.
 */
export class OAuthCallbackQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(512)
  code?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  state!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  error?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  error_description?: string;
}
