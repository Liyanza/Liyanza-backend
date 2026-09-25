import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { DigitalCampaignsController } from './digital-campaigns.controller';
import { DigitalCampaignsService } from './digital-campaigns.service';
import { PrismaModule } from '../prisma/prisma.module';
import { DigitalSimulationEngineHeuristic } from './clients/digital-simulation-engine.heuristic';
import { DIGITAL_SIMULATION_ENGINE_TOKEN } from './clients/digital-simulation-engine.interface';
import { SimulationAnalysisClient } from './clients/simulation-analysis.client';
import { CampaignPerformanceService } from './performance/campaign-performance.service';
import { LocalBenchmarksService } from './performance/local-benchmarks.service';
import { RedisModule } from '../redis/redis.module';
import { SocialAccountsModule } from '../social-accounts/social-accounts.module';

@Module({
  // L'analyse IA d'une simulation prend quelques secondes (un appel LLM) ;
  // au-delà de 45 s, la simulation est enregistrée sans analyse.
  imports: [
    PrismaModule,
    RedisModule,
    SocialAccountsModule,
    HttpModule.register({ timeout: 45_000 }),
  ],
  controllers: [DigitalCampaignsController],
  providers: [
    DigitalCampaignsService,
    CampaignPerformanceService,
    LocalBenchmarksService,
    SimulationAnalysisClient,
    {
      provide: DIGITAL_SIMULATION_ENGINE_TOKEN,
      useClass: DigitalSimulationEngineHeuristic,
    },
  ],
})
export class DigitalCampaignsModule {}
