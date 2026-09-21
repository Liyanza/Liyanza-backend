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

/**
 * Contrat de connexion Google DEPUIS L'APP MOBILE (Flutter) — distinct
 * d'`OAuthLoginClient` ci-dessus : le SDK natif `google_sign_in` résout déjà
 * l'identité de l'utilisateur sur l'appareil et ne renvoie qu'un `idToken`
 * (JWT signé par Google), il n'y a donc ni `redirect_uri`, ni `state`, ni
 * échange de `code` — un unique aller-retour serveur : vérifier la signature
 * et l'audience du token, puis émettre directement la paire de tokens
 * Liyanza (voir `AuthService.loginWithGoogleIdToken`).
 *
 * Interface séparée (plutôt qu'une méthode ajoutée à `OAuthLoginClient`) :
 * Facebook n'a pas d'équivalent "idToken vérifiable côté serveur" dans ce
 * flow, une méthode commune obligerait `FacebookOAuthClient` à l'implémenter
 * pour rien.
 */
export interface GoogleIdTokenVerifier {
  /**
   * Vérifie la signature, l'expiration et l'audience (le `GOOGLE_CLIENT_ID`
   * "Application Web" existant, voir `GoogleOAuthClient.verifyIdToken`) d'un
   * `idToken` Google, puis retourne le profil résolu. Lève une erreur si le
   * token est invalide/expiré/mal destiné, ou si le compte Google n'a pas
   * d'email vérifié — l'appelant traduit systématiquement cette erreur en
   * 401, jamais en 500 brute.
   */
  verifyIdToken(idToken: string): Promise<OAuthUserProfile>;
}

export const GOOGLE_ID_TOKEN_VERIFIER_TOKEN = 'GOOGLE_ID_TOKEN_VERIFIER_TOKEN';
