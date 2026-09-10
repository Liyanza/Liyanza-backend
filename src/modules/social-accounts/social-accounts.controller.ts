import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Request,
  HttpCode,
  HttpStatus,
  Redirect,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request as ExpressRequest } from 'express';
import { Role } from '@prisma/client';
import { SocialAccountsService } from './social-accounts.service';
import { SocialAccountQueryDto } from './dto/social-account-query.dto';
import { OAuthCallbackQueryDto } from './dto/oauth-callback-query.dto';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Roles } from '../auth/decorators/roles.decorator';
import { Public } from '../auth/decorators/public.decorator';

interface AuthenticatedRequest extends ExpressRequest {
  user: AuthenticatedUser;
}

@Controller('social-accounts')
export class SocialAccountsController {
  constructor(private readonly socialAccountsService: SocialAccountsService) {}

  /**
   * Lecture seule, transverse à tous les rôles authentifiés (comme
   * `GET /notifications`/`GET /tasks`) : n'importe quel membre de
   * l'entreprise doit pouvoir voir si un compte Meta est déjà lié avant de
   * démarrer le wizard de campagne digitale — pas de `@Roles(...)`.
   */
  @Get()
  async findAll(
    @Query() query: SocialAccountQueryDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.socialAccountsService.findAll(req.user, query);
  }

  /**
   * Démarre le flow OAuth Meta — réservé ADMIN/MARKETING_MANAGER (décision
   * produit validée : lier l'identité Meta de l'entreprise est une action
   * d'infrastructure, pas un geste de contenu).
   */
  @Post('oauth/:platform/start')
  @Roles(Role.ADMIN, Role.MARKETING_MANAGER)
  async startOAuth(
    @Param('platform') platform: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.socialAccountsService.startOAuth(platform, req.user);
  }

  /**
   * Callback public appelé directement par Meta après consentement de
   * l'utilisateur — jamais de JWT (le navigateur/webview n'en porte pas à
   * ce stade). Protégé par le `state` à usage unique (voir
   * `SocialAccountsService.handleOAuthCallback`), throttlé pour limiter
   * l'impact d'un rejeu automatisé de l'URL de callback.
   */
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('oauth/callback')
  @Redirect()
  async oauthCallback(@Query() query: OAuthCallbackQueryDto) {
    const { redirectUrl } =
      await this.socialAccountsService.handleOAuthCallback(query);
    return { url: redirectUrl, statusCode: HttpStatus.FOUND };
  }

  /**
   * Déconnexion réservée à ADMIN/MARKETING_MANAGER — décision produit
   * validée : lier/délier l'identité Meta de l'entreprise est une action
   * d'infrastructure au même niveau que la création/le lancement de
   * campagne, pas un geste de contenu.
   */
  @Delete(':id')
  @Roles(Role.ADMIN, Role.MARKETING_MANAGER)
  @HttpCode(HttpStatus.OK)
  async revoke(@Param('id') id: string, @Request() req: AuthenticatedRequest) {
    return this.socialAccountsService.revoke(id, req.user);
  }

  /** Re-synchronisation manuelle des métriques (en plus du sync automatique). */
  @Post(':id/sync')
  @Roles(Role.ADMIN, Role.MARKETING_MANAGER)
  @HttpCode(HttpStatus.ACCEPTED)
  async triggerSync(
    @Param('id') id: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.socialAccountsService.triggerSync(id, req.user);
  }
}
