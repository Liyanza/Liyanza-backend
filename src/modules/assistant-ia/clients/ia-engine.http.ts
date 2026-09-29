import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';
import { IAEngineInterface } from './ia-engine.interface';
import type {
  AskPublicQuestionParams,
  AskQuestionParams,
  AskQuestionResult,
  GenerateRecommendationsParams,
  GenerateRecommendationsResult,
  RecommendationPriority,
} from './ia-engine.interface';

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
/** Durée maximale d'une réponse en flux, de la requête au dernier morceau. */
const STREAM_TIMEOUT_MS = 120_000;

/**
 * Attente maximale des recommandations : le service borne lui-même Gemini à
 * 2 × 20 s + 1 s (`ask_llm_json`), on lui laisse un peu de marge.
 */
const RECOMMENDATIONS_TIMEOUT_MS = 50_000;

interface RecommendationsResponse {
  recommendations?: Array<{
    title?: unknown;
    detail?: unknown;
    priority?: unknown;
    category?: unknown;
  }>;
}

const PRIORITIES: readonly RecommendationPriority[] = ['high', 'medium', 'low'];

function parseSseEvent(raw: string): { type: string; text?: string } | null {
  const data = raw
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('');
  if (!data) return null;
  try {
    return JSON.parse(data) as { type: string; text?: string };
  } catch {
    return null;
  }
}

@Injectable()
export class IAEngineHttpClient implements IAEngineInterface {
  private readonly logger = new Logger(IAEngineHttpClient.name);

  constructor(
    private readonly http: HttpService,
    private readonly configService: ConfigService,
  ) {}

  askQuestion = (params: AskQuestionParams): Promise<AskQuestionResult> =>
    this.postAsk(params);

  /** Mode vitrine du service chatbot : voir `AskPublicQuestionParams`. */
  askPublicQuestion = (
    params: AskPublicQuestionParams,
  ): Promise<AskQuestionResult> =>
    this.postAsk({
      mode: 'public',
      userMessage: params.userMessage,
      context: { recentMessages: params.recentMessages ?? [] },
    });

  private target(): { baseUrl: string; token: string } {
    return {
      baseUrl: this.configService
        .getOrThrow<string>('IA_SERVICE_URL')
        .replace(/\/+$/, ''),
      token: this.configService.getOrThrow<string>('IA_SERVICE_INTERNAL_TOKEN'),
    };
  }

  private async postAsk(body: object): Promise<AskQuestionResult> {
    const { baseUrl, token } = this.target();

    try {
      const { data } = await firstValueFrom(
        this.http.post<AskQuestionResult>(`${baseUrl}/ask`, body, {
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
  }

  streamQuestion = (params: AskQuestionParams): AsyncIterable<string> =>
    this.postStream(params);

  streamPublicQuestion = (
    params: AskPublicQuestionParams,
  ): AsyncIterable<string> =>
    this.postStream({
      mode: 'public',
      userMessage: params.userMessage,
      context: { recentMessages: params.recentMessages ?? [] },
    });

  /**
   * `POST /ask/stream` : lit le flux SSE du service chatbot et renvoie le
   * texte de chaque événement `delta`. `fetch` natif plutôt que
   * `HttpService` (axios) : sa lecture en flux est bien plus simple.
   */
  private async *postStream(body: object): AsyncGenerator<string> {
    const { baseUrl, token } = this.target();
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/ask/stream`, {
        method: 'POST',
        headers: {
          'X-Internal-Token': token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(STREAM_TIMEOUT_MS),
      });
    } catch (error) {
      const message = `IA service unreachable (${error instanceof Error ? error.name : 'unknown'})`;
      this.logger.warn(message);
      throw new Error(message);
    }
    if (!response.ok || !response.body) {
      const message = `IA service responded ${response.status}`;
      this.logger.warn(message);
      throw new Error(message);
    }

    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const event = parseSseEvent(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        if (!event) continue;
        if (event.type === 'delta' && event.text) yield event.text;
        else if (event.type === 'done') return;
        else if (event.type === 'error') {
          throw new Error('IA stream interrupted');
        }
      }
    }
    throw new Error('IA stream ended without completion');
  }

  /**
   * `POST /campaign/recommendations` : 3 à 5 conseils rédigés par Gemini à
   * partir du contexte complet de la campagne. Lève en cas d'échec : mieux
   * vaut un message « réessayez » qu'une recommandation factice.
   */
  generateRecommendations = async (
    params: GenerateRecommendationsParams,
  ): Promise<GenerateRecommendationsResult> => {
    const { baseUrl, token } = this.target();
    let data: RecommendationsResponse;
    try {
      ({ data } = await firstValueFrom(
        this.http.post<RecommendationsResponse>(
          `${baseUrl}/campaign/recommendations`,
          params,
          {
            headers: {
              'X-Internal-Token': token,
              'Content-Type': 'application/json',
            },
            timeout: RECOMMENDATIONS_TIMEOUT_MS,
          },
        ),
      ));
    } catch (error) {
      throw this.toIAError(error);
    }

    const recommendations = (data?.recommendations ?? []).flatMap((item) => {
      const title = typeof item.title === 'string' ? item.title.trim() : '';
      const content = typeof item.detail === 'string' ? item.detail.trim() : '';
      if (!title || !content) return [];
      const priority = PRIORITIES.includes(
        item.priority as RecommendationPriority,
      )
        ? (item.priority as RecommendationPriority)
        : 'medium';
      const category =
        typeof item.category === 'string' && item.category
          ? item.category
          : undefined;
      return [{ title, content, priority, category }];
    });
    if (recommendations.length === 0) {
      this.logger.warn('IA service returned no usable recommendation');
      throw new Error('IA service returned no recommendation');
    }
    return { recommendations };
  };

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
