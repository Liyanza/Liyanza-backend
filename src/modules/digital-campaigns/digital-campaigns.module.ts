import { Module } from '@nestjs/common';
import { DigitalCampaignsController } from './digital-campaigns.controller';
import { DigitalCampaignsService } from './digital-campaigns.service';
import { PrismaModule } from '../prisma/prisma.module';
import { DigitalSimulationEngineMock } from './clients/digital-simulation-engine.mock';
import { DIGITAL_SIMULATION_ENGINE_TOKEN } from './clients/digital-simulation-engine.interface';

@Module({
  imports: [PrismaModule],
  controllers: [DigitalCampaignsController],
  providers: [
    DigitalCampaignsService,
    {
      provide: DIGITAL_SIMULATION_ENGINE_TOKEN,
      useClass: DigitalSimulationEngineMock,
    },
  ],
})
export class DigitalCampaignsModule {}
