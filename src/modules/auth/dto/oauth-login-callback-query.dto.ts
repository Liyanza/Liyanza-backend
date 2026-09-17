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

  // Paramètres ajoutés par Google (jamais par Facebook) à CE callback précis,
  // en plus de `code`/`state` — non documentés dans un schéma officiel mais
  // systématiquement présents en pratique : `iss` (émetteur du jeton),
  // `scope` (scopes effectivement accordés), `authuser` (index de session
  // Google multi-compte), `prompt` (type d'écran affiché). Le
  // `ValidationPipe` global tourne avec `forbidNonWhitelisted: true` : sans
  // ces champs, TOUT callback Google est rejeté en 400 avant même d'atteindre
  // `AuthService`. On les déclare donc uniquement pour les accepter — comme
  // indiqué plus haut, ils ne sont jamais lus ni utilisés.
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  iss?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  scope?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  authuser?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  prompt?: string;
}
