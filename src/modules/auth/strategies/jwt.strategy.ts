import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import {
  AuthenticatedUser,
  JwtPayload,
} from '../interfaces/authenticated-user.interface';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private configService: ConfigService) {
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
   */
  validate(payload: JwtPayload): AuthenticatedUser {
    if (!payload?.sub || !payload.role) {
      throw new UnauthorizedException('Token invalide.');
    }

    return {
      userId: payload.sub,
      email: payload.email,
      role: payload.role,
      companyId: payload.companyId ?? null,
    };
  }
}
