/**
 * Contrat vers un fournisseur OAuth de CONNEXION (Google/Facebook, BACK-505)
 * — homologue de `SocialPlatformClientInterface` (module social-accounts),
 * mais pour authentifier un utilisateur anonyme plutôt que lier un compte
 * pro déjà authentifié. Interface committée pour permettre un mock dans les
 * tests (`.claude/skills/liyanza-testing/SKILL.md` : jamais mocker un client
 * HTTP bas niveau directement dans le test du service).
 */
export interface OAuthUserProfile {
  /** Identifiant stable côté provider (Google `sub`, Facebook `id`). */
  providerId: string;
  email: string;
  firstName: string;
  lastName: string;
}

export interface OAuthLoginClient {
  /** Construit l'URL d'autorisation vers laquelle rediriger le navigateur. */
  getAuthorizationUrl(state: string, redirectUri: string): string;

  /**
   * Échange le `code` du callback contre le profil de l'utilisateur.
   * Lève une erreur si l'échange échoue ou si le provider ne renvoie pas
   * d'email (ex: utilisateur Facebook sans email vérifié) — l'appelant
   * traduit cette erreur en redirection d'échec, jamais en 500 brute.
   */
  exchangeCodeForProfile(
    code: string,
    redirectUri: string,
  ): Promise<OAuthUserProfile>;
}

export const GOOGLE_OAUTH_CLIENT_TOKEN = 'GOOGLE_OAUTH_CLIENT_TOKEN';
export const FACEBOOK_OAUTH_CLIENT_TOKEN = 'FACEBOOK_OAUTH_CLIENT_TOKEN';
