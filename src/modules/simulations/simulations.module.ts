import { Module } from '@nestjs/common';
import { SimulationsController } from './simulations.controller';
import { SimulationsService } from './simulations.service';
import { PrismaModule } from '../prisma/prisma.module';
import { BillingModule } from '../billing/billing.module';
import { SimulationEngineMock } from './clients/simulation-engine.mock';
import { SIMULATION_ENGINE_TOKEN } from './clients/simulation-engine.interface';

@Module({
  imports: [PrismaModule, BillingModule],
  controllers: [SimulationsController],
  providers: [
    SimulationsService,
    {
      provide: SIMULATION_ENGINE_TOKEN,
      useClass: SimulationEngineMock,
    },
  ],
})
export class SimulationsModule {}
