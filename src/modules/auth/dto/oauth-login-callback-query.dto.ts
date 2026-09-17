import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Query string du callback OAuth public de CONNEXION
 * (`GET /auth/google/callback`, `GET /auth/facebook/callback`) — homologue
 * de `OAuthCallbackQueryDto` (module social-accounts), dupliqué
 * volontairement plutôt que partagé entre modules : même forme minimale,
 * domaines différents (connexion anonyme vs liaison d'un compte pro
 * authentifié).
 *
 * `code`/`state` sont les SEULES données de cette requête auxquelles on fait
 * confiance, et uniquement pour retrouver le `state` à usage unique dans
 * Redis — jamais de champ d'identité lu depuis la query string elle-même.
 */
export class OAuthLoginCallbackQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(2048)
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
