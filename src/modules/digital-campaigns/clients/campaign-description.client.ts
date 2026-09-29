import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';

export interface CampaignDescriptionInput {
  name: string;
  product: string;
  objective?: string;
  companyProfile?: { name: string; businessSector: string; address: string };
}

/**
 * Client de `POST /campaign/description` du service `kiyanza_assistant_ia` :
 * rédige la description d'une campagne à partir de son nom et de ce qu'elle
 * promeut. `null` sans service configuré ; lève en cas d'échec.
 */
@Injectable()
export class CampaignDescriptionClient {
  private readonly logger = new Logger(CampaignDescriptionClient.name);

  constructor(
    private readonly http: HttpService,
    private readonly configService: ConfigService,
  ) {}

  async describe(input: CampaignDescriptionInput): Promise<string | null> {
    const baseUrl = this.configService.get<string>('IA_SERVICE_URL');
    if (!baseUrl) return null;
    const token = this.configService.getOrThrow<string>(
      'IA_SERVICE_INTERNAL_TOKEN',
    );
    try {
      const { data } = await firstValueFrom(
        this.http.post<{ description?: string }>(
          `${baseUrl.replace(/\/+$/, '')}/campaign/description`,
          input,
          { headers: { 'X-Internal-Token': token } },
        ),
      );
      const description = data?.description?.trim();
      if (!description) throw new Error('IA service returned no description');
      return description;
    } catch (error) {
      const message =
        error instanceof AxiosError
          ? error.response
            ? `IA service responded ${error.response.status}`
            : `IA service unreachable (${error.code ?? error.message})`
          : error instanceof Error
            ? error.message
            : 'Unknown IA error';
      this.logger.warn(`Campaign description failed: ${message}`);
      throw new Error(message);
    }
  }
}
