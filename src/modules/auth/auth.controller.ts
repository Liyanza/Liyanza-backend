import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Request,
  Redirect,
  HttpStatus,
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
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { LogoutDto } from './dto/logout.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { OAuthLoginCallbackQueryDto } from './dto/oauth-login-callback-query.dto';
import { OAuthExchangeDto } from './dto/oauth-exchange.dto';
import { GoogleMobileLoginDto } from './dto/google-mobile-login.dto';
import { Public } from './decorators/public.decorator';
import { Roles } from './decorators/roles.decorator';
import { AuthenticatedUser } from './interfaces/authenticated-user.interface';

interface AuthenticatedRequest extends ExpressRequest {
  user: AuthenticatedUser;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  // SÉCURITÉ (correctif audit — majeur) : ces trois endpoints sont publics
  // par nature et constituent la cible évidente d'attaques par force brute
  // / credential stuffing / spam d'inscription. On leur applique une limite
  // dédiée, plus stricte que la limite globale (`default`).
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } }) // 5 inscriptions / min / IP
  @Post('register')
  @ApiOperation({ summary: 'Register a new user (no company, lowest role)' })
  @ApiResponse({ status: 201, description: 'User created' })
  @ApiResponse({ status: 409, description: 'Email already in use' })
  async register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } }) // 5 tentatives / min / IP
  @Post('login')
  @ApiOperation({ summary: 'Log in and receive an access/refresh token pair' })
  @ApiResponse({ status: 201, description: 'Authenticated' })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  async login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('refresh')
  @ApiOperation({
    summary:
      'Exchange a (single-use) refresh token for a new access/refresh pair',
  })
  @ApiResponse({ status: 201, description: 'Tokens rotated' })
  @ApiResponse({
    status: 401,
    description: 'Invalid, expired or already-used refresh token',
  })
  async refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refresh(dto.refreshToken);
  }

  // ------------------------------------------------------------------
  // BACK-505 — Connexion Google/Facebook. DISTINCT du flow OAuth Meta de
  // `SocialAccountsController` (`/social-accounts/oauth/...`), qui lie un
  // compte pro à une campagne pour un utilisateur DÉJÀ authentifié — ici
  // l'appelant est anonyme, c'est justement le but de la route.
  // ------------------------------------------------------------------

  // Routes littérales plutôt qu'un unique `:provider` paramétré : la
  // dernière version de `path-to-regexp` (utilisée par Express sous Nest)
  // a supprimé le support des contraintes regex inline façon
  // `:provider(google|facebook)` (PathError au boot). Un `:provider` non
  // contraint entrerait en plus en collision avec `GET /auth/me` et
  // `GET /auth/admin-check` ci-dessous (même forme d'URL à un segment) :
  // deux routes littérales par fournisseur évitent les deux problèmes.
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Get('google')
  @ApiOperation({ summary: 'Start the Google login OAuth flow' })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the provider consent screen',
  })
  async startGoogleLogin() {
    return this.authService.startOAuthLogin('google');
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Get('facebook')
  @ApiOperation({ summary: 'Start the Facebook login OAuth flow' })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the provider consent screen',
  })
  async startFacebookLogin() {
    return this.authService.startOAuthLogin('facebook');
  }

  // SÉCURITÉ : callback public appelé DIRECTEMENT par Google/Facebook après
  // consentement de l'utilisateur — jamais de JWT à ce stade (l'utilisateur
  // n'est pas encore authentifié). Throttle aligné sur le callback OAuth Meta
  // déjà en place (`GET /social-accounts/oauth/callback`, 30/min) : même
  // nature de trafic (redirection navigateur après interaction humaine).
  // Protégé par un `state` à usage unique consommé atomiquement dans Redis.
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('google/callback')
  @Redirect()
  @ApiOperation({
    summary: 'Google login callback (called by Google, not by API clients)',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the frontend result page',
  })
  async googleLoginCallback(@Query() query: OAuthLoginCallbackQueryDto) {
    const { redirectUrl } = await this.authService.handleOAuthLoginCallback(
      'google',
      query,
    );
    return { url: redirectUrl, statusCode: HttpStatus.FOUND };
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('facebook/callback')
  @Redirect()
  @ApiOperation({
    summary: 'Facebook login callback (called by Facebook, not by API clients)',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to the frontend result page',
  })
  async facebookLoginCallback(@Query() query: OAuthLoginCallbackQueryDto) {
    const { redirectUrl } = await this.authService.handleOAuthLoginCallback(
      'facebook',
      query,
    );
    return { url: redirectUrl, statusCode: HttpStatus.FOUND };
  }

  // ------------------------------------------------------------------
  // BACK-507 — Connexion Google DEPUIS L'APP MOBILE (Flutter, SDK natif
  // `google_sign_in`). DISTINCT du flow `GET /auth/google` ci-dessus (conçu
  // pour un navigateur web, redirection + code d'échange) : ici l'app a déjà
  // résolu l'identité nativement et n'envoie qu'un `idToken` à vérifier — un
  // seul aller-retour, pas de redirection.
  // ------------------------------------------------------------------
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('google/mobile')
  @ApiOperation({
    summary: 'Log in from the mobile app using a native Google Sign-In idToken',
  })
  @ApiResponse({ status: 201, description: 'Authenticated' })
  @ApiResponse({
    status: 401,
    description: 'Invalid or expired Google idToken',
  })
  async googleMobileLogin(@Body() dto: GoogleMobileLoginDto) {
    return this.authService.loginWithGoogleIdToken(dto);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('oauth/exchange')
  @ApiOperation({
    summary:
      'Exchange a short-lived OAuth login code (from the redirect URL) for an access/refresh token pair',
  })
  @ApiResponse({ status: 201, description: 'Authenticated' })
  @ApiResponse({ status: 401, description: 'Invalid or expired exchange code' })
  async exchangeOAuthCode(@Body() dto: OAuthExchangeDto) {
    return this.authService.exchangeOAuthCode(dto);
  }

  // ------------------------------------------------------------------
  // BACK-506 — Réinitialisation de mot de passe
  // ------------------------------------------------------------------

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } }) // même limite que login/register — vecteur d'énumération/spam
  @Post('forgot-password')
  @ApiOperation({ summary: 'Request a password reset link by email' })
  @ApiResponse({
    status: 201,
    description:
      'Always returns success, regardless of whether the email exists',
  })
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('reset-password')
  @ApiOperation({
    summary: 'Reset the password using a (single-use) reset token',
  })
  @ApiResponse({
    status: 201,
    description: 'Password updated, all sessions revoked',
  })
  @ApiResponse({ status: 401, description: 'Invalid or expired reset token' })
  async resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  // Protégé par le JwtAuthGuard global (aucun décorateur nécessaire).
  //
  // CORRECTIF AUDIT : le refresh token peut désormais être transmis pour ne
  // fermer QUE la session courante (web ou mobile). S'il est omis, toutes les
  // sessions de l'utilisateur sont révoquées — comportement « déconnexion de
  // tous les appareils ».
  @Post('logout')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Log out (current session, or all sessions if no refreshToken is given)',
  })
  @ApiResponse({ status: 201, description: 'Logged out' })
  async logout(@Request() req: AuthenticatedRequest, @Body() dto: LogoutDto) {
    return this.authService.logout(req.user.userId, dto.refreshToken);
  }

  /**
   * Endpoint de vérification RBAC (BACK-106) : retourne l'identité résolue
   * par JwtAuthGuard pour n'importe quel rôle authentifié. Sert à valider
   * manuellement le critère "401 sans token" du DoD.
   */
  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get the identity resolved from the access token' })
  @ApiResponse({ status: 200, description: 'Current user identity' })
  me(@Request() req: AuthenticatedRequest) {
    return req.user;
  }

  /**
   * Endpoint de vérification RBAC (BACK-106) : réservé au rôle ADMIN.
   * Sert à valider manuellement le critère "403 avec rôle insuffisant" du
   * DoD via curl. À retirer/adapter une fois de vrais endpoints ADMIN
   * disponibles dans les modules métier.
   */
  @Get('admin-check')
  @Roles(Role.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'RBAC smoke test reserved to ADMIN' })
  @ApiResponse({ status: 200, description: 'ADMIN access confirmed' })
  @ApiResponse({ status: 403, description: 'Insufficient role' })
  adminCheck(@Request() req: AuthenticatedRequest) {
    return { message: `Accès ADMIN confirmé pour ${req.user.email}.` };
  }
}
