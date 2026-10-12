import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ChariowConfig } from './chariow.config';

export const CHARIOW_API_URL = 'https://api.chariow.com/v1';

/** Délai maximal d'un appel à l'API Chariow. */
const CHARIOW_TIMEOUT_MS = 15_000;

export interface ChariowCheckoutRequest {
  product_id: string;
  email: string;
  first_name: string;
  last_name: string;
  phone: { number: string; country_code: string };
  redirect_url?: string;
  customer_ip?: string;
  custom_metadata: Record<string, string>;
}

export type ChariowCheckoutResult =
  | { step: 'payment'; checkoutUrl: string }
  | { step: 'completed' | 'already_purchased'; checkoutUrl: null };

interface ChariowCheckoutResponse {
  message?: unknown;
  data?: {
    step?: unknown;
    payment?: { checkout_url?: unknown } | null;
  };
}

const PAYMENT_UNAVAILABLE =
  'Le paiement est momentanément indisponible. Réessayez dans un instant.';

/**
 * Client minimal de l'API Chariow (fetch natif). La clé API n'apparaît
 * jamais dans les logs ni dans les erreurs renvoyées au client : seuls le
 * statut HTTP et le message de Chariow sont journalisés.
 */
@Injectable()
export class ChariowClient {
  private readonly logger = new Logger(ChariowClient.name);

  constructor(private readonly config: ChariowConfig) {}

  async createCheckout(
    body: ChariowCheckoutRequest,
  ): Promise<ChariowCheckoutResult> {
    const apiKey = this.config.apiKey;
    if (!apiKey) {
      throw new ServiceUnavailableException(
        "Le paiement en ligne n'est pas configuré sur ce serveur.",
      );
    }

    let response: Response;
    try {
      response = await fetch(`${CHARIOW_API_URL}/checkout`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CHARIOW_TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.error(
        `Chariow checkout request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new BadGatewayException(PAYMENT_UNAVAILABLE);
    }

    const payload = (await response
      .json()
      .catch(() => null)) as ChariowCheckoutResponse | null;

    if (!response.ok) {
      const detail =
        typeof payload?.message === 'string'
          ? payload.message.slice(0, 300)
          : 'no message';
      this.logger.error(
        `Chariow checkout rejected (HTTP ${response.status}) for product ${body.product_id}: ${detail}`,
      );
      throw new BadGatewayException(PAYMENT_UNAVAILABLE);
    }

    const step = payload?.data?.step;
    if (step === 'payment') {
      const url = payload?.data?.payment?.checkout_url;
      if (typeof url === 'string' && /^https:\/\//.test(url)) {
        return { step, checkoutUrl: url };
      }
    } else if (step === 'completed' || step === 'already_purchased') {
      return { step, checkoutUrl: null };
    }

    this.logger.error(
      `Unexpected Chariow checkout response (step: ${String(step)})`,
    );
    throw new BadGatewayException(PAYMENT_UNAVAILABLE);
  }
}
