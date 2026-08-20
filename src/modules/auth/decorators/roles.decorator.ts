import { SetMetadata } from '@nestjs/common';
import { Role } from '@prisma/client';

export const ROLES_KEY = 'roles';

/**
 * Déclare les rôles autorisés à accéder à un handler (ou à tout un contrôleur).
 * Consommé par `RolesGuard`. Sans ce décorateur, un endpoint protégé reste
 * accessible à n'importe quel utilisateur authentifié (401/403 gérés séparément
 * par `JwtAuthGuard`), ce qui est le comportement attendu par défaut.
 *
 * @example
 * @Roles(Role.ADMIN, Role.MARKETING_MANAGER)
 * @Post('campaigns')
 * create(@Body() dto: CreateCampaignDto) { ... }
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
