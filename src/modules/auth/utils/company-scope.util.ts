import { NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

/**
 * Vérifie qu'un utilisateur authentifié a le droit d'accéder à une ressource
 * rattachée à une entreprise donnée (isolation multi-tenant).
 *
 * À appeler dans la couche SERVICE des modules métier des phases suivantes,
 * une fois la ressource chargée depuis la base (ex: après
 * `prisma.campaign.findUnique(...)`), car c'est à ce moment-là que la
 * `companyId` réelle de la ressource est connue — un guard HTTP seul ne peut
 * pas le savoir avant d'avoir lu la base.
 *
 * Comportement volontaire : on lève un `NotFoundException` (404) plutôt qu'un
 * `ForbiddenException` (403) quand la ressource appartient à une autre
 * entreprise. Cela évite de révéler l'existence de ressources d'entreprises
 * tierces (énumération d'IDs) — pratique standard de sécurité pour
 * l'isolation multi-tenant.
 *
 * @param user            L'utilisateur authentifié courant (`request.user`)
 * @param resourceCompanyId La companyId propriétaire de la ressource accédée
 * @param resourceName    Nom de la ressource, pour un message d'erreur clair
 *
 * @example
 * const campaign = await this.prisma.campaign.findUnique({
 *   where: { id },
 *   include: { launchedBy: true },
 * });
 * if (!campaign) throw new NotFoundException('Campagne introuvable.');
 * assertSameCompany(user, campaign.launchedBy.companyId, 'Campagne');
 */
export function assertSameCompany(
  user: AuthenticatedUser,
  resourceCompanyId: string | null | undefined,
  resourceName = 'Ressource',
): void {
  if (
    !user.companyId ||
    !resourceCompanyId ||
    user.companyId !== resourceCompanyId
  ) {
    throw new NotFoundException(`${resourceName} introuvable.`);
  }
}

/**
 * Variante permissive pour les rôles qui ont explicitement le droit de
 * traverser les entreprises (aucun rôle du MCD actuel n'a ce besoin à ce
 * jour — prévu pour une future évolution, ex: un rôle plateforme "SUPPORT").
 * Non utilisée tant qu'aucun rôle cross-tenant n'est validé par le PO.
 */
export function assertSameCompanyUnless(
  user: AuthenticatedUser,
  resourceCompanyId: string | null | undefined,
  bypassRoles: Role[],
  resourceName = 'Ressource',
): void {
  if (bypassRoles.includes(user.role)) {
    return;
  }
  assertSameCompany(user, resourceCompanyId, resourceName);
}
