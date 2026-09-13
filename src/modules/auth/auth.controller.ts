import { Controller, Post, Get, Body, Request } from '@nestjs/common';
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
