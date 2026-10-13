import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { DemoService } from './demo.service';

/**
 * Démo publique en lecture seule : données de l'entreprise fictive
 * (`DemoService`, remise à zéro au démarrage et chaque nuit). La connexion
 * (`POST /auth/demo`) vit dans `AuthController`, la lecture seule dans
 * `DemoReadOnlyGuard` (garde globale) et le plafond du Copilot dans
 * `PlanService` : ce module ne fait qu'écrire les données.
 */
@Module({
  imports: [PrismaModule],
  providers: [DemoService],
  exports: [DemoService],
})
export class DemoModule {}
