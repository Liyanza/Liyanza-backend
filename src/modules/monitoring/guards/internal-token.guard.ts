import { createHash, timingSafeEqual } from 'crypto';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

const INTERNAL_TOKEN_HEADER = 'x-internal-token';

/**
 * Autorise `POST /internal/monitoring/detections` sur la base d'un secret
 * partagé (`INTERNAL_MONITORING_TOKEN`) plutôt qu'un JWT utilisateur — le
 * futur service `Liyanza-ia` n'a pas de compte applicatif. Remplace le
 * mécanisme VPC prévu par la roadmap d'origine, inapplicable sur Render
 * (voir §3 de `CLAUDE.md`).
 *
 * Comparaison en temps constant (garde-fou §11) : on hache d'abord les deux
 * valeurs (longueur fixe, 32 octets) avant `timingSafeEqual`, qui lève sinon
 * une exception si les deux buffers n'ont pas la même longueur — ce qui
 * fuiterait déjà la longueur du secret via un side-channel trivial.
 */
@Injectable()
export class InternalTokenGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const provided = request.headers[INTERNAL_TOKEN_HEADER];

    const expected = this.configService.get<string>(
      'INTERNAL_MONITORING_TOKEN',
    )!;

    if (typeof provided !== 'string' || !this.safeCompare(provided, expected)) {
      throw new UnauthorizedException('Invalid or missing internal token.');
    }

    return true;
  }

  private safeCompare(a: string, b: string): boolean {
    const hashA = createHash('sha256').update(a).digest();
    const hashB = createHash('sha256').update(b).digest();
    return timingSafeEqual(hashA, hashB);
  }
}
