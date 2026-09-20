import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';
import {
  EmailMessage,
  EmailProvider,
} from '../interfaces/email-provider.interface';

const BREVO_SEND_URL = 'https://api.brevo.com/v3/smtp/email';

interface BrevoErrorBody {
  message?: string;
  code?: string;
}

/**
 * Transport HTTP (API transactionnelle Brevo) — alternative à
 * `SmtpEmailProvider` sélectionnée via `EMAIL_PROVIDER=brevo_api`. Voir le
 * commentaire sur `EMAIL_PROVIDER` dans `env.validation.ts` : Render bloque
 * les connexions sortantes vers le port SMTP 587, HTTPS/443 ne l'est pas.
 */
@Injectable()
export class BrevoApiEmailProvider implements EmailProvider {
  private readonly logger = new Logger(BrevoApiEmailProvider.name);

  constructor(
    private readonly http: HttpService,
    private readonly configService: ConfigService,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    const apiKey = this.configService.getOrThrow<string>('BREVO_API_KEY');
    const fromAddress = this.configService.getOrThrow<string>('SMTP_FROM');

    try {
      await firstValueFrom(
        this.http.post(
          BREVO_SEND_URL,
          {
            sender: { email: fromAddress },
            to: [{ email: message.to }],
            subject: message.subject,
            textContent: message.text,
          },
          {
            headers: {
              'api-key': apiKey,
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
          },
        ),
      );
    } catch (error) {
      throw this.toEmailError(error);
    }
  }

  private toEmailError(error: unknown): Error {
    if (error instanceof AxiosError) {
      const body = error.response?.data as BrevoErrorBody | undefined;
      const message = body?.message ?? error.message;
      this.logger.warn(`Brevo API error: ${message} (code=${body?.code})`);
      return new Error(`Brevo API error: ${message}`);
    }
    return error instanceof Error
      ? error
      : new Error('Unknown Brevo API error');
  }
}
