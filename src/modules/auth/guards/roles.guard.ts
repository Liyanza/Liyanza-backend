import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { Request } from 'express';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}

/**
 * Garde RBAC. S'exécute APRÈS `JwtAuthGuard` (donc `request.user` est déjà
 * hydraté) et compare `user.role` à la liste de rôles déclarée via `@Roles()`.
 *
 * - Aucun `@Roles()` déclaré sur le handler/contrôleur => accès autorisé à
 *   n'importe quel utilisateur authentifié (le guard ne fait rien de plus).
 * - `@Roles()` déclaré mais rôle de l'utilisateur absent de la liste => 403.
 *
 * Enregistrée globalement (APP_GUARD) pour centraliser la logique RBAC et
 * éviter toute duplication dans les contrôleurs métier des phases suivantes.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;

    // Défense en profondeur : si JwtAuthGuard n'a pas tourné avant (mauvais
    // ordre d'enregistrement, guard local mal configuré...), on refuse plutôt
    // que de laisser passer.
    if (!user) {
      throw new ForbiddenException('Access denied: user not authenticated.');
    }

    if (!requiredRoles.includes(user.role)) {
      throw new ForbiddenException(
        `Access denied: insufficient role (required role among [${requiredRoles.join(', ')}]).`,
      );
    }

    return true;
  }
}
