import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';
import { OAuth2Client, TokenPayload } from 'google-auth-library';
import {
  GoogleIdTokenVerifier,
  OAuthLoginClient,
  OAuthUserProfile,
} from './oauth-login-client.interface';

interface GoogleTokenResponse {
  access_token: string;
  id_token: string;
  token_type: string;
  expires_in: number;
}

interface GoogleUserInfo {
  sub: string;
  email?: string;
  email_verified?: boolean;
  given_name?: string;
  family_name?: string;
  name?: string;
}

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_ENDPOINT =
  'https://www.googleapis.com/oauth2/v3/userinfo';

/**
 * Implémentation réelle (BACK-505), pas un mock — ce n'est pas un LLM/service
 * d'inférence, voir `.claude/skills/liyanza-ia-boundary/SKILL.md`.
 *
 * Ne demande jamais `access_type=offline` : ce client ne sert qu'à résoudre
 * l'identité de l'utilisateur une seule fois au moment de la connexion, pas
 * à appeler l'API Google en son nom plus tard — aucun refresh token Google à
 * conserver, donc pas de surface de tokens supplémentaire à sécuriser.
 */
@Injectable()
export class GoogleOAuthClient
  implements OAuthLoginClient, GoogleIdTokenVerifier
{
  private readonly logger = new Logger(GoogleOAuthClient.name);

  private readonly idTokenClient = new OAuth2Client();

  constructor(
    private readonly http: HttpService,
    private readonly configService: ConfigService,
  ) {}

  getAuthorizationUrl(state: string, redirectUri: string): string {
    const url = new URL(GOOGLE_AUTH_ENDPOINT);
    url.searchParams.set(
      'client_id',
      this.configService.getOrThrow<string>('GOOGLE_CLIENT_ID'),
    );
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', state);
    return url.toString();
  }

  async exchangeCodeForProfile(
    code: string,
    redirectUri: string,
  ): Promise<OAuthUserProfile> {
    const token = await this.post<GoogleTokenResponse>(GOOGLE_TOKEN_ENDPOINT, {
      code,
      client_id: this.configService.getOrThrow<string>('GOOGLE_CLIENT_ID'),
      client_secret: this.configService.getOrThrow<string>(
        'GOOGLE_CLIENT_SECRET',
      ),
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });

    const userInfo = await this.get<GoogleUserInfo>(GOOGLE_USERINFO_ENDPOINT, {
      Authorization: `Bearer ${token.access_token}`,
    });

    if (!userInfo.email) {
      throw new Error('Google account has no email associated.');
    }

    return {
      providerId: userInfo.sub,
      email: userInfo.email,
      firstName: userInfo.given_name ?? userInfo.name ?? 'Utilisateur',
      lastName: userInfo.family_name ?? '',
    };
  }

  /**
   * BACK-507 — Connexion Google DEPUIS L'APP MOBILE (Flutter, `google_sign_in`).
   * Vérifie la signature RS256 et l'expiration via les clés publiques Google
   * (mise en cache/rotation gérées par `google-auth-library`, jamais par un
   * appel réseau par login), PLUS l'audience (`aud`).
   *
   * L'audience attendue est le MÊME `GOOGLE_CLIENT_ID` "Application Web" que
   * le flow navigateur ci-dessus — PAS un client id "Android"/"iOS" séparé.
   * Ces derniers doivent bien exister côté Google Cloud Console (ils
   * autorisent le sélecteur de compte natif à s'exécuter pour CET
   * applicationId/bundle id précis, vérifié par Google via l'empreinte
   * SHA-1/le bundle id), mais l'app Flutter leur demande explicitement
   * d'émettre un idToken dont l'audience est le client "Application Web"
   * (paramètre `serverClientId` de `google_sign_in`) : c'est la manière
   * documentée par Google d'obtenir un idToken vérifiable par un serveur tiers
   * — voir `docs/GUIDE_MOBILE_GOOGLE_SIGNIN.md`. Sans ce contrôle d'audience,
   * n'importe quel idToken Google valide (émis pour une AUTRE app) serait
   * accepté ici.
   */
  async verifyIdToken(idToken: string): Promise<OAuthUserProfile> {
    let payload: TokenPayload | undefined;
    try {
      const ticket = await this.idTokenClient.verifyIdToken({
        idToken,
        audience: this.configService.getOrThrow<string>('GOOGLE_CLIENT_ID'),
      });
      payload = ticket.getPayload();
    } catch (error) {
      this.logger.warn(
        `Google mobile idToken verification failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw new Error('Invalid Google idToken.');
    }

    if (!payload?.email) {
      throw new Error('Google account has no email associated.');
    }
    if (payload.email_verified === false) {
      throw new Error('Google account email is not verified.');
    }

    return {
      providerId: payload.sub,
      email: payload.email,
      firstName: payload.given_name ?? payload.name ?? 'Utilisateur',
      lastName: payload.family_name ?? '',
    };
  }

  private async post<T>(url: string, body: Record<string, string>): Promise<T> {
    try {
      const response = await firstValueFrom(
        this.http.post<T>(url, new URLSearchParams(body).toString(), {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }),
      );
      return response.data;
    } catch (error) {
      throw this.toError('token exchange', error);
    }
  }

  private async get<T>(
    url: string,
    headers: Record<string, string>,
  ): Promise<T> {
    try {
      const response = await firstValueFrom(this.http.get<T>(url, { headers }));
      return response.data;
    } catch (error) {
      throw this.toError('userinfo fetch', error);
    }
  }

  private toError(step: string, error: unknown): Error {
    if (error instanceof AxiosError) {
      const message =
        (error.response?.data as { error_description?: string })
          ?.error_description ?? error.message;
      this.logger.warn(`Google OAuth ${step} failed: ${message}`);
      return new Error(`Google OAuth ${step} failed: ${message}`);
    }
    return error instanceof Error
      ? error
      : new Error('Unknown Google OAuth error');
  }
}
