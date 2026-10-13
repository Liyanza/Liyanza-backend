import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { DEMO_ALLOWED_KEY } from '../decorators/demo-allowed.decorator';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}

/** Méthodes sans effet : toujours permises, démo comprise. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const DEMO_READ_ONLY_CODE = 'DEMO_READ_ONLY';

/**
 * 403 renvoyée à une session de démo qui tente d'écrire. Le `code` stable
 * (relayé par `AllExceptionsFilter`) permet au site d'afficher son propre
 * message (« Créez votre compte pour… ») plutôt qu'une erreur générique.
 */
export class DemoReadOnlyException extends ForbiddenException {
  constructor() {
    super({
      statusCode: 403,
      code: DEMO_READ_ONLY_CODE,
      message:
        'Vous explorez la démo en lecture seule : créez votre compte gratuit pour lancer vos propres campagnes.',
    });
  }
}

/**
 * Garde globale de la démo publique, enregistrée juste après `JwtAuthGuard`
 * (`request.user` est donc hydraté, `demo` relu en base par `JwtStrategy`).
 *
 * Tous les visiteurs partagent le même compte et les mêmes données : une
 * seule écriture se verrait chez tous les autres jusqu'à la remise à zéro
 * nocturne. On refuse donc toute méthode d'écriture, sauf les routes
 * marquées `@DemoAllowed()` (déconnexion, Copilot). Deny-by-default comme
 * `JwtAuthGuard` : une nouvelle route d'écriture est protégée sans rien
 * faire. Les routes `@Public()` (pas de `request.user`) et les sessions
 * normales ne sont jamais concernées.
 */
@Injectable()
export class DemoReadOnlyGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.user?.demo) {
      return true;
    }
    if (READ_METHODS.has(request.method.toUpperCase())) {
      return true;
    }

    const allowed = this.reflector.getAllAndOverride<boolean>(
      DEMO_ALLOWED_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (allowed) {
      return true;
    }

    throw new DemoReadOnlyException();
  }
}
