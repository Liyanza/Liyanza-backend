import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

interface CompanyScopedRequest extends Request {
  user?: AuthenticatedUser;
}

/**
 * Garde d'isolation multi-tenant (« Ownership » au sens du ticket) pour les
 * routes dont la ressource est identifiée directement par une `companyId`
 * dans l'URL, par exemple :
 *
 *   GET /companies/:companyId/campaigns
 *   GET /companies/:companyId/users
 *
 * S'exécute après `JwtAuthGuard` (donc `request.user` est déjà hydraté) et
 * refuse l'accès si `params.companyId` ne correspond pas à `user.companyId`.
 *
 * IMPORTANT : ce guard ne couvre QUE le cas où l'URL porte la companyId
 * directement. Pour les ressources imbriquées dont la companyId n'est connue
 * qu'après lecture en base (ex: /campaigns/:id, /installations/:id), utiliser
 * `assertSameCompany()` (voir `company-scope.util.ts`) dans le service
 * correspondant, une fois la ressource chargée.
 *
 * Retourne un 404 (et non un 403) en cas de mismatch, pour ne pas révéler
 * l'existence de l'entreprise ciblée à un utilisateur qui n'y a pas accès.
 *
 * @example
 * @UseGuards(CompanyScopeGuard)
 * @Get('companies/:companyId/campaigns')
 * findAll(@Param('companyId') companyId: string) { ... }
 */
@Injectable()
export class CompanyScopeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<CompanyScopedRequest>();
    const user = request.user;
    const targetCompanyId = request.params.companyId;

    if (!targetCompanyId) {
      // Le guard est mal branché sur une route sans :companyId — on ne
      // masque pas l'erreur de config, on la laisse remonter clairement.
      throw new Error(
        'CompanyScopeGuard requires a route parameter ":companyId".',
      );
    }

    if (!user || !user.companyId || user.companyId !== targetCompanyId) {
      throw new NotFoundException('Entreprise introuvable.');
    }

    return true;
  }
}
