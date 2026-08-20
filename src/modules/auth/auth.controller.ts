import { Controller, Post, Get, Body, Request } from '@nestjs/common';
import { Request as ExpressRequest } from 'express';
import { Role } from '@prisma/client';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { Public } from './decorators/public.decorator';
import { Roles } from './decorators/roles.decorator';
import { AuthenticatedUser } from './interfaces/authenticated-user.interface';

interface AuthenticatedRequest extends ExpressRequest {
  user: AuthenticatedUser;
}

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Public()
  @Post('register')
  async register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Public()
  @Post('login')
  async login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Public()
  @Post('refresh')
  async refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refresh(dto.refreshToken);
  }

  // Protégé par le JwtAuthGuard global (aucun décorateur nécessaire).
  @Post('logout')
  async logout(@Request() req: AuthenticatedRequest) {
    const userId = req.user.userId;
    return this.authService.logout(userId);
  }

  /**
   * Endpoint de vérification RBAC (BACK-106) : retourne l'identité résolue
   * par JwtAuthGuard pour n'importe quel rôle authentifié. Sert à valider
   * manuellement le critère "401 sans token" du DoD.
   */
  @Get('me')
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
  adminCheck(@Request() req: AuthenticatedRequest) {
    return { message: `Accès ADMIN confirmé pour ${req.user.email}.` };
  }
}
