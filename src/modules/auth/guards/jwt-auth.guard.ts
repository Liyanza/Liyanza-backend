import {
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * Garde JWT globale (deny-by-default).
 *
 * Enregistrée comme `APP_GUARD` dans `AppModule`, elle protège TOUS les
 * endpoints par défaut : tout nouveau contrôleur/handler métier des phases
 * suivantes est automatiquement protégé, sans action supplémentaire côté
 * développeur. Seuls les handlers explicitement annotés `@Public()`
 * (ex: /auth/login, /health) y échappent.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    return super.canActivate(context);
  }

  // Surcharge pour garantir un 401 explicite (et non un 500) en cas de
  // token absent, invalide, expiré ou de user introuvable après validate().
  handleRequest<TUser = unknown>(
    err: unknown,
    user: TUser,
    info: unknown,
  ): TUser {
    if (err || !user) {
      const reason =
        info instanceof Error ? info.message : 'Authentication required.';
      throw err instanceof Error
        ? err
        : new UnauthorizedException(reason || 'Authentication required.');
    }
    return user;
  }
}
