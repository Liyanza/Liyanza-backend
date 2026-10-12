import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import {
  BillingController,
  ChariowWebhookController,
} from './billing.controller';
import { BillingService } from './billing.service';
import { ChariowClient } from './chariow.client';
import { ChariowConfig } from './chariow.config';
import { ChariowWebhookService } from './chariow-webhook.service';
import { PlanService } from './plan.service';

/**
 * Abonnements payants (Chariow) et limites des formules. N'importe que
 * Prisma : les modules métier importent `BillingModule` pour `PlanService`
 * sans risque d'import circulaire.
 */
@Module({
  imports: [PrismaModule],
  controllers: [BillingController, ChariowWebhookController],
  providers: [
    PlanService,
    BillingService,
    ChariowConfig,
    ChariowClient,
    ChariowWebhookService,
  ],
  exports: [PlanService],
})
export class BillingModule {}
