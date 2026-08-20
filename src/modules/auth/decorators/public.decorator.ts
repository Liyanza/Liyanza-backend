import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marque un handler (ou tout un contrôleur) comme public, c'est-à-dire exempté
 * du `JwtAuthGuard` global (deny-by-default).
 *
 * À utiliser UNIQUEMENT pour :
 * - les endpoints d'authentification eux-mêmes (`/auth/login`, `/auth/register`, `/auth/refresh`)
 * - les endpoints de santé/infra interrogés sans JWT (`/health`, `/`) par l'ALB / ECS
 *
 * @example
 * @Public()
 * @Post('login')
 * login(@Body() dto: LoginDto) { ... }
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
