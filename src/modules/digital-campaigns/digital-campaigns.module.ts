import { Module } from '@nestjs/common';
import { DigitalCampaignsController } from './digital-campaigns.controller';
import { DigitalCampaignsService } from './digital-campaigns.service';
import { PrismaModule } from '../prisma/prisma.module';
import { DigitalSimulationEngineHeuristic } from './clients/digital-simulation-engine.heuristic';
import { DIGITAL_SIMULATION_ENGINE_TOKEN } from './clients/digital-simulation-engine.interface';

@Module({
  imports: [PrismaModule],
  controllers: [DigitalCampaignsController],
  providers: [
    DigitalCampaignsService,
    {
      provide: DIGITAL_SIMULATION_ENGINE_TOKEN,
      useClass: DigitalSimulationEngineHeuristic,
    },
  ],
})
export class DigitalCampaignsModule {}
