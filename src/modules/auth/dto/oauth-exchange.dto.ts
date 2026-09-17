import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Appelée par le frontend (Route Handler Next.js), jamais directement par le
 * navigateur : échange le code d'échange à usage unique reçu dans l'URL de
 * redirection contre la vraie paire de tokens (voir
 * `AuthService.exchangeOAuthCode`).
 */
export class OAuthExchangeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  code!: string;
}
