import { Module } from '@nestjs/common';
import { AssistantIController } from './assistant-ia.controller';
import { AssistantIService } from './assistant-ia.service';
import { PrismaModule } from '../prisma/prisma.module';
import { IA_ENGINE_TOKEN } from './clients/ia-engine.interface';
import { IAEngineMock } from './clients/ia-engine.mock';

@Module({
  imports: [PrismaModule],
  controllers: [AssistantIController],
  providers: [
    AssistantIService,
    {
      provide: IA_ENGINE_TOKEN,
      useClass: IAEngineMock,
    },
  ],
})
export class AssistantIAModule {}
