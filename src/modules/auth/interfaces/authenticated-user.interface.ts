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
 * Payload signé dans le JWT (access & refresh token).
 * Volontairement minimal : on ne met dans le token que ce qui est nécessaire
 * à l'autorisation (RBAC + scope entreprise), jamais de données sensibles.
 */
export interface JwtPayload {
  sub: string;
  email: string;
  role: Role;
  companyId: string | null;
}
