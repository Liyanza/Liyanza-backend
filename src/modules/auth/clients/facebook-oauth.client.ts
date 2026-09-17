import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';
import {
  OAuthLoginClient,
  OAuthUserProfile,
} from './oauth-login-client.interface';

interface FacebookTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
}

interface FacebookMeResponse {
  id: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  name?: string;
}

interface FacebookErrorBody {
  error?: { message?: string };
}

/**
 * Implémentation réelle (BACK-505) de la connexion Facebook — DISTINCTE de
 * `MetaGraphClient` (liaison d'un compte pro à une campagne, BACK-502/503) :
 * même famille d'API (Graph API), même App Meta réutilisée
 * (META_APP_ID/META_APP_SECRET), mais portée fonctionnelle différente
 * (identité personnelle vs Page professionnelle) et redirect_uri dédiée
 * (FACEBOOK_LOGIN_REDIRECT_URI). Gardée séparée plutôt que fusionnée dans
 * `MetaGraphClient` pour ne pas mélanger les deux domaines dans une même
 * classe implémentant deux interfaces différentes.
 */
@Injectable()
export class FacebookOAuthClient implements OAuthLoginClient {
  private readonly logger = new Logger(FacebookOAuthClient.name);

  constructor(
    private readonly http: HttpService,
    private readonly configService: ConfigService,
  ) {}

  private get baseUrl(): string {
    const version =
      this.configService.get<string>('META_GRAPH_API_VERSION') ?? 'v21.0';
    return `https://graph.facebook.com/${version}`;
  }

  getAuthorizationUrl(state: string, redirectUri: string): string {
    const version =
      this.configService.get<string>('META_GRAPH_API_VERSION') ?? 'v21.0';
    const url = new URL(`https://www.facebook.com/${version}/dialog/oauth`);
    url.searchParams.set(
      'client_id',
      this.configService.getOrThrow<string>('META_APP_ID'),
    );
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('scope', 'email,public_profile');
    url.searchParams.set('response_type', 'code');
    return url.toString();
  }

  async exchangeCodeForProfile(
    code: string,
    redirectUri: string,
  ): Promise<OAuthUserProfile> {
    const token = await this.graphGet<FacebookTokenResponse>(
      '/oauth/access_token',
      {
        client_id: this.configService.getOrThrow<string>('META_APP_ID'),
        client_secret: this.configService.getOrThrow<string>('META_APP_SECRET'),
        redirect_uri: redirectUri,
        code,
      },
    );

    const me = await this.graphGet<FacebookMeResponse>('/me', {
      fields: 'id,email,first_name,last_name,name',
      access_token: token.access_token,
    });

    // Un utilisateur Facebook sans email vérifié (ou ayant refusé la
    // permission `email`) ne renvoie PAS ce champ — cas attendu, à traiter
    // proprement (redirection d'erreur) plutôt que de créer un compte sans
    // identifiant unique exploitable.
    if (!me.email) {
      throw new Error('Facebook account has no email associated.');
    }

    return {
      providerId: me.id,
      email: me.email,
      firstName: me.first_name ?? me.name ?? 'Utilisateur',
      lastName: me.last_name ?? '',
    };
  }

  private async graphGet<T>(
    path: string,
    params: Record<string, string>,
  ): Promise<T> {
    try {
      const response = await firstValueFrom(
        this.http.get<T>(`${this.baseUrl}${path}`, { params }),
      );
      return response.data;
    } catch (error) {
      throw this.toError(error);
    }
  }

  private toError(error: unknown): Error {
    if (error instanceof AxiosError) {
      const body = error.response?.data as FacebookErrorBody | undefined;
      const message = body?.error?.message ?? error.message;
      this.logger.warn(`Facebook OAuth login failed: ${message}`);
      return new Error(`Facebook OAuth login failed: ${message}`);
    }
    return error instanceof Error
      ? error
      : new Error('Unknown Facebook OAuth error');
  }
}
