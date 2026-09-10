/**
 * Erreur générique renvoyée par l'API Graph de Meta (`{error: {message,
 * code, ...}}`). Jamais renvoyée telle quelle au client HTTP de ce repo —
 * `SocialAccountsService`/les processors la traduisent en exception NestJS
 * appropriée (voir `AllExceptionsFilter`, garde-fou §8 : pas de détail
 * d'erreur interne/tiers brut au client).
 */
export class MetaApiError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
    public readonly raw?: unknown,
  ) {
    super(message);
    this.name = 'MetaApiError';
  }
}

/**
 * Code d'erreur Meta 190 : token invalide/expiré/révoqué par l'utilisateur.
 * Distingué explicitement pour que l'appelant marque `SocialAccount.status
 * = EXPIRED` plutôt que de traiter ça comme une panne transitoire à
 * retenter.
 */
export class MetaTokenExpiredError extends MetaApiError {
  constructor(message: string, raw?: unknown) {
    super(message, 190, raw);
    this.name = 'MetaTokenExpiredError';
  }
}
