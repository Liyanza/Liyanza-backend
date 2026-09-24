import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';
import { IAEngineInterface } from './ia-engine.interface';
import type {
  AskQuestionParams,
  AskQuestionResult,
  GenerateRecommendationsParams,
  GenerateRecommendationsResult,
} from './ia-engine.interface';
import { IAEngineMock } from './ia-engine.mock';

/**
 * Client HTTP du service chatbot `kiyanza_assistant_ia` (FastAPI, hébergé
 * sur AWS EC2) — sélectionné par `AssistantIAModule` dès que
 * `IA_SERVICE_URL` est défini, le mock restant utilisé sinon (dev local,
 * tests).
 *
 * Le service n'est jamais appelé par un navigateur : seul ce backend le
 * joint, authentifié par le secret partagé `X-Internal-Token` (même
 * mécanisme que `InternalTokenGuard`, dans l'autre sens).
 */
@Injectable()
export class IAEngineHttpClient implements IAEngineInterface {
  private readonly logger = new Logger(IAEngineHttpClient.name);
  private readonly recommendationsFallback = new IAEngineMock();

  constructor(
    private readonly http: HttpService,
    private readonly configService: ConfigService,
  ) {}

  askQuestion = async (
    params: AskQuestionParams,
  ): Promise<AskQuestionResult> => {
    const baseUrl = this.configService
      .getOrThrow<string>('IA_SERVICE_URL')
      .replace(/\/+$/, '');
    const token = this.configService.getOrThrow<string>(
      'IA_SERVICE_INTERNAL_TOKEN',
    );

    try {
      const { data } = await firstValueFrom(
        this.http.post<AskQuestionResult>(`${baseUrl}/ask`, params, {
          headers: {
            'X-Internal-Token': token,
            'Content-Type': 'application/json',
          },
        }),
      );
      if (typeof data?.answer !== 'string' || data.answer.length === 0) {
        throw new Error('IA service returned no answer');
      }
      return { answer: data.answer };
    } catch (error) {
      throw this.toIAError(error);
    }
  };

  // Le service chatbot n'expose pas (encore) de génération de
  // recommandations : on garde le comportement du mock pour cette méthode
  // plutôt que de casser `POST /campagnes/:id/recommandations/generer`.
  generateRecommendations = (
    params: GenerateRecommendationsParams,
  ): Promise<GenerateRecommendationsResult> =>
    this.recommendationsFallback.generateRecommendations(params);

  private toIAError(error: unknown): Error {
    if (error instanceof AxiosError) {
      const status = error.response?.status;
      const message = status
        ? `IA service responded ${status}`
        : `IA service unreachable (${error.code ?? error.message})`;
      this.logger.warn(message);
      return new Error(message);
    }
    return error instanceof Error ? error : new Error('Unknown IA error');
  }
}
