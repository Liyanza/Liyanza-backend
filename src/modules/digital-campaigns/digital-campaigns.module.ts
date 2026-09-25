import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { DigitalCampaignsController } from './digital-campaigns.controller';
import { DigitalCampaignsService } from './digital-campaigns.service';
import { PrismaModule } from '../prisma/prisma.module';
import { DigitalSimulationEngineHeuristic } from './clients/digital-simulation-engine.heuristic';
import { DIGITAL_SIMULATION_ENGINE_TOKEN } from './clients/digital-simulation-engine.interface';
import { SimulationAnalysisClient } from './clients/simulation-analysis.client';

@Module({
  // L'analyse IA d'une simulation prend quelques secondes (un appel LLM) ;
  // au-delà de 45 s, la simulation est enregistrée sans analyse.
  imports: [PrismaModule, HttpModule.register({ timeout: 45_000 })],
  controllers: [DigitalCampaignsController],
  providers: [
    DigitalCampaignsService,
    SimulationAnalysisClient,
    {
      provide: DIGITAL_SIMULATION_ENGINE_TOKEN,
      useClass: DigitalSimulationEngineHeuristic,
    },
  ],
})
export class DigitalCampaignsModule {}
