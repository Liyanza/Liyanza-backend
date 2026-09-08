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
   * CORRECTIF AUDIT (faille critique #1 — confusion access/refresh) : tout
   * token signé avec `JWT_SECRET` était accepté ici, y compris un refresh
   * token. Comme celui-ci portait exactement le même payload et vivait 7
   * jours, il constituait de fait un access token longue durée que `logout()`
   * ne révoquait pas. On exige désormais explicitement `type === 'access'`.
   *
   * CORRECTIF AUDIT (faille critique #2 — privilèges figés) : `role` et
   * `companyId` provenaient des claims du JWT, jamais de la base. Un
   * utilisateur rétrogradé ou exclu de son entreprise conservait donc ses
   * anciens droits jusqu'à expiration du token. Ces deux valeurs — les seules
   * dont dépendent respectivement le RBAC (`RolesGuard`) et l'isolation
   * multi-tenant (`assertSameCompany`) — sont désormais relues en base à
   * chaque requête, en même temps que le contrôle de désactivation qui s'y
   * faisait déjà. Le coût est nul : c'est la même requête, sur la même clé
   * primaire, avec deux colonnes de plus dans le `select`.
   */
  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    if (!payload?.sub || payload.type !== 'access') {
      throw new UnauthorizedException('Token invalide.');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        role: true,
        companyId: true,
        deactivatedAt: true,
      },
    });

    if (!user || user.deactivatedAt) {
      throw new UnauthorizedException(
        "Ce compte est désactivé ou n'existe plus.",
      );
    }

    return {
      userId: user.id,
      email: user.email,
      role: user.role,
      companyId: user.companyId,
    };
  }
}
