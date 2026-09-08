import { Role } from '@prisma/client';

/**
 * Forme normalisée de `request.user`, hydratée par `JwtStrategy.validate()`.
 *
 * `companyId` est déterminant pour l'isolation multi-tenant : c'est la valeur
 * comparée par `CompanyScopeGuard` / `assertSameCompany()` pour garantir
 * qu'un utilisateur ne peut jamais accéder aux données d'une autre `Entreprise`.
 * Elle peut être `null` (utilisateur non rattaché à une entreprise, ex: onboarding
 * en cours), auquel cas tout accès à une ressource scoping par entreprise est refusé.
 */
export interface AuthenticatedUser {
  userId: string;
  email: string;
  role: Role;
  companyId: string | null;
}

/**
 * Nature d'un token émis par `AuthService`.
 *
 * SÉCURITÉ (correctif audit — faille critique) : access token et refresh
 * token étaient auparavant signés avec le MÊME secret et le MÊME payload,
 * sans aucun claim permettant de les distinguer. Conséquence : un refresh
 * token était accepté tel quel comme `Authorization: Bearer ...` par
 * `JwtStrategy`, offrant à un attaquant 7 jours d'accès à l'API au lieu des
 * 15 minutes prévues — et `logout()` (qui ne supprime que la clé Redis) ne
 * révoquait rien du tout.
 */
export type TokenType = 'access' | 'refresh';

/**
 * Payload signé dans le JWT (access & refresh token).
 * Volontairement minimal : on ne met dans le token que ce qui est nécessaire
 * à l'autorisation (RBAC + scope entreprise), jamais de données sensibles.
 *
 * `role` et `companyId` restent présents à titre informatif (débogage,
 * corrélation), mais ne font plus autorité : `JwtStrategy.validate()` les
 * relit systématiquement en base — voir le correctif associé.
 */
export interface JwtPayload {
  sub: string;
  email: string;
  role: Role;
  companyId: string | null;
  /** Distingue un access token d'un refresh token. Obligatoire depuis le correctif d'audit. */
  type: TokenType;
  /** Identifiant unique du token, utilisé pour la rotation des refresh tokens. */
  jti?: string;
}
