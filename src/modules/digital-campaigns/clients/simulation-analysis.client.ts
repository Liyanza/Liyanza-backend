import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';

/** Analyse produite par le service IA — forme stockée dans `DigitalSimulation.aiAnalysis`. */
export interface SimulationAnalysis {
  summary: string;
  strengths: string[];
  risks: string[];
  recommendations: Array<{ title: string; detail: string }>;
  scenarioChoice: string;
}

/**
 * Paramètres et résultats d'une simulation, envoyés au service IA
 * (modèle Pydantic `SimulationAnalysisRequest` de `chatbot_api.py`).
 * Toujours limités à l'entreprise de l'utilisateur.
 */
export interface SimulationAnalysisInput {
  campaignName?: string;
  objective: string;
  budget: { amount: number; allocation?: string };
  startDate?: string;
  endDate?: string;
  audience: {
    ageMin?: number;
    ageMax?: number;
    targetGender?: string;
    locations: string[];
    interests: string[];
  };
  channels: string[];
  companyProfile?: { name: string; businessSector: string; address: string };
  results: {
    predictedReach?: number;
    predictedEngagementRate?: number;
    predictedCtr?: number;
    predictedRoas?: number;
    avgCpc?: number;
    costPerAcquisition?: number;
    conversionRate?: number;
    warnings: string[];
  };
  scenarios: unknown[];
  channelBreakdown: unknown[];
}

/**
 * Client de `POST /simulation/analyze` du service `kiyanza_assistant_ia`
 * (même URL et même secret que le Copilot : `IA_SERVICE_URL`,
 * `IA_SERVICE_INTERNAL_TOKEN`).
 *
 * L'analyse est un COMPLÉMENT : sans service configuré, `analyze` renvoie
 * `null` sans appel réseau, et une erreur est levée à l'appelant, qui
 * enregistre alors la simulation sans analyse plutôt que d'échouer.
 */
@Injectable()
export class SimulationAnalysisClient {
  private readonly logger = new Logger(SimulationAnalysisClient.name);

  constructor(
    private readonly http: HttpService,
    private readonly configService: ConfigService,
  ) {}

  async analyze(
    input: SimulationAnalysisInput,
  ): Promise<SimulationAnalysis | null> {
    const baseUrl = this.configService.get<string>('IA_SERVICE_URL');
    if (!baseUrl) return null;
    const token = this.configService.getOrThrow<string>(
      'IA_SERVICE_INTERNAL_TOKEN',
    );

    try {
      const { data } = await firstValueFrom(
        this.http.post<SimulationAnalysis>(
          `${baseUrl.replace(/\/+$/, '')}/simulation/analyze`,
          input,
          {
            headers: {
              'X-Internal-Token': token,
              'Content-Type': 'application/json',
            },
          },
        ),
      );
      if (typeof data?.summary !== 'string' || !data.summary) {
        throw new Error('IA service returned no analysis');
      }
      return data;
    } catch (error) {
      const message =
        error instanceof AxiosError
          ? error.response
            ? `IA service responded ${error.response.status}`
            : `IA service unreachable (${error.code ?? error.message})`
          : error instanceof Error
            ? error.message
            : 'Unknown IA error';
      this.logger.warn(`Simulation analysis failed: ${message}`);
      throw new Error(message);
    }
  }
}
