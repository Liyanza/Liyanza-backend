import { Module } from '@nestjs/common';
import { HttpModule, HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { AssistantIController } from './assistant-ia.controller';
import { AssistantIService } from './assistant-ia.service';
import { PrismaModule } from '../prisma/prisma.module';
import { IA_ENGINE_TOKEN } from './clients/ia-engine.interface';
import { IAEngineMock } from './clients/ia-engine.mock';
import { IAEngineHttpClient } from './clients/ia-engine.http';

@Module({
  // Une réponse du chatbot enchaîne jusqu'à deux appels LLM (génération SQL
  // puis réponse finale) : 10 s, comme pour Brevo, serait bien trop court.
  imports: [PrismaModule, HttpModule.register({ timeout: 120_000 })],
  controllers: [AssistantIController],
  providers: [
    AssistantIService,
    {
      provide: IA_ENGINE_TOKEN,
      useFactory: (configService: ConfigService, http: HttpService) =>
        configService.get<string>('IA_SERVICE_URL')
          ? new IAEngineHttpClient(http, configService)
          : new IAEngineMock(),
      inject: [ConfigService, HttpService],
    },
  ],
})
export class AssistantIAModule {}
