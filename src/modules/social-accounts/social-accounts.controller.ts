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
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { SocialAccountsService } from './social-accounts.service';
import { PageHealthService } from './page-health/page-health.service';
import { SocialAccountQueryDto } from './dto/social-account-query.dto';
import { OAuthCallbackQueryDto } from './dto/oauth-callback-query.dto';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Roles } from '../auth/decorators/roles.decorator';
import { Public } from '../auth/decorators/public.decorator';

interface AuthenticatedRequest extends ExpressRequest {
  user: AuthenticatedUser;
}

@ApiTags('social-accounts')
@Controller('social-accounts')
export class SocialAccountsController {
  constructor(
    private readonly socialAccountsService: SocialAccountsService,
    private readonly pageHealthService: PageHealthService,
  ) {}

  /**
   * Santé d'une Page Facebook liée — lecture seule, ouverte à tous les rôles
   * de l'entreprise comme `GET /social-accounts`.
   */
  @Get(':id/health')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Facebook Page health (28 days, best posts and times)',
  })
  @ApiResponse({ status: 409, description: 'The Page must be reconnected' })
  async getHealth(
    @Param('id') id: string,
    @Query('refresh') refresh: string | undefined,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.pageHealthService.getHealth(
      id,
      req.user,
      refresh === '1' || refresh === 'true',
    );
  }

  /** Génère le résumé IA de la santé de la Page (conservé 7 jours). */
  @Post(':id/health/analysis')
  @Roles(Role.ADMIN, Role.MARKETING_MANAGER, Role.COMMUNITY_MANAGER)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Generate the AI summary of the Page health' })
  @ApiResponse({ status: 503, description: 'AI service unavailable' })
  async analyzeHealth(
    @Param('id') id: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.pageHealthService.analyze(id, req.user);
  }

  /**
   * Lecture seule, transverse à tous les rôles authentifiés (comme
   * `GET /notifications`/`GET /tasks`) : n'importe quel membre de
   * l'entreprise doit pouvoir voir si un compte Meta est déjà lié avant de
   * démarrer le wizard de campagne digitale — pas de `@Roles(...)`.
   */
  @Get()
  @ApiBearerAuth()
  @ApiOperation({ summary: "List the company's linked social accounts" })
  @ApiResponse({ status: 200, description: 'Paginated social accounts' })
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
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Start the Meta OAuth flow (Facebook/Instagram)' })
  @ApiResponse({ status: 201, description: 'Authorization URL to open' })
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
  @ApiOperation({
    summary: 'Meta OAuth callback (called by Meta, not by API clients)',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the mobile/web result page',
  })
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
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke a linked social account' })
  @ApiResponse({ status: 200, description: 'Social account revoked' })
  async revoke(@Param('id') id: string, @Request() req: AuthenticatedRequest) {
    return this.socialAccountsService.revoke(id, req.user);
  }

  /** Re-synchronisation manuelle des métriques (en plus du sync automatique). */
  @Post(':id/sync')
  @Roles(Role.ADMIN, Role.MARKETING_MANAGER)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Trigger a manual metrics sync' })
  @ApiResponse({ status: 202, description: 'Sync job enqueued' })
  async triggerSync(
    @Param('id') id: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.socialAccountsService.triggerSync(id, req.user);
  }
}
