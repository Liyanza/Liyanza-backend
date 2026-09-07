import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AuthenticatedUser,
  JwtPayload,
} from '../interfaces/authenticated-user.interface';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {
    const secret = configService.get<string>('JWT_SECRET');
    if (!secret) {
      throw new Error('JWT_SECRET is not defined');
    }
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
    });
  }

  /**
   * Exécuté par Passport après vérification de la signature et de
   * l'expiration du token. La valeur retournée hydrate `request.user`,
   * consommée ensuite par `RolesGuard` et `CompanyScopeGuard` /
   * `assertSameCompany()`.
   *
   * CORRECTIF AUDIT (mineur) : la validation se limitait auparavant à la
   * signature du token, sans vérifier que l'utilisateur existe toujours ou
   * n'a pas été désactivé entre-temps (`UsersService.deactivate()`). Un
   * utilisateur désactivé pouvait donc continuer à utiliser son access
   * token jusqu'à son expiration naturelle. On ajoute une vérification en
   * base à chaque requête authentifiée.
   *
   * Compromis assumé : cela ajoute une lecture BDD par requête. Les access
   * tokens ayant une durée de vie courte (15 min par défaut), l'impact
   * sécurité d'une non-vérification serait de toute façon limité — mais
   * dès lors que l'information est disponible à faible coût (table `User`
   * indexée sur `id`), autant fermer la fenêtre de révocation immédiate
   * (désactivation de compte, suppression) plutôt que d'attendre
   * l'expiration du token.
   */
  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    if (!payload?.sub || !payload.role) {
      throw new UnauthorizedException('Token invalide.');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, deactivatedAt: true },
    });

    if (!user || user.deactivatedAt) {
      throw new UnauthorizedException(
        "Ce compte est désactivé ou n'existe plus.",
      );
    }

    return {
      userId: payload.sub,
      email: payload.email,
      role: payload.role,
      companyId: payload.companyId ?? null,
    };
  }
}
