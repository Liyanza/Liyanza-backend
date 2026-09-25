import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';

/** Analyse produite par le service IA (POST /page-health/analyze). */
export interface PageHealthAnalysis {
  summary: string;
  strengths: string[];
  watchouts: string[];
  actions: Array<{ title: string; detail: string }>;
}

/**
 * Client de `POST /page-health/analyze` du service `kiyanza_assistant_ia`
 * (même URL et même secret que le Copilot et l'analyse de simulation).
 * `null` sans service configuré ; lève en cas d'échec.
 */
@Injectable()
export class PageHealthAnalysisClient {
  private readonly logger = new Logger(PageHealthAnalysisClient.name);

  constructor(
    private readonly http: HttpService,
    private readonly configService: ConfigService,
  ) {}

  async analyze(input: unknown): Promise<PageHealthAnalysis | null> {
    const baseUrl = this.configService.get<string>('IA_SERVICE_URL');
    if (!baseUrl) return null;
    const token = this.configService.getOrThrow<string>(
      'IA_SERVICE_INTERNAL_TOKEN',
    );

    try {
      const { data } = await firstValueFrom(
        this.http.post<PageHealthAnalysis>(
          `${baseUrl.replace(/\/+$/, '')}/page-health/analyze`,
          input,
          {
            headers: {
              'X-Internal-Token': token,
              'Content-Type': 'application/json',
            },
            // Un appel LLM : bien plus long que les appels Meta du module.
            timeout: 45_000,
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
      this.logger.warn(`Page health analysis failed: ${message}`);
      throw new Error(message);
    }
  }
}
