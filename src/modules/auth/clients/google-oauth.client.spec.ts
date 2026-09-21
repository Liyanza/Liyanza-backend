/* eslint-disable @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { of, throwError } from 'rxjs';
import { AxiosError, type AxiosResponse } from 'axios';
import { OAuth2Client } from 'google-auth-library';
import { GoogleOAuthClient } from './google-oauth.client';

// CORRECTIF TEST : `google-auth-library` fait un vrai appel réseau (fetch des
// clés publiques JWKS Google) à l'intérieur de `OAuth2Client.verifyIdToken`.
// On mocke la classe entière plutôt que de mocker un client HTTP bas niveau
// utilisé en interne par la lib (voir `.claude/skills/liyanza-testing/SKILL.md`
// — ici la lib EST le client externe à mocker, comme `HttpService` ci-dessous
// pour le flow navigateur).
jest.mock('google-auth-library');

function axiosResponse<T>(data: T): AxiosResponse<T> {
  return {
    data,
    status: 200,
    statusText: 'OK',
    headers: {},
    config: {} as AxiosResponse['config'],
  };
}

describe('GoogleOAuthClient', () => {
  let client: GoogleOAuthClient;
  let http: { get: jest.Mock; post: jest.Mock };
  let configService: { get: jest.Mock; getOrThrow: jest.Mock };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GoogleOAuthClient,
        { provide: HttpService, useValue: { get: jest.fn(), post: jest.fn() } },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(),
            getOrThrow: jest.fn((key: string) => `config:${key}`),
          },
        },
      ],
    }).compile();

    client = module.get(GoogleOAuthClient);
    http = module.get(HttpService);
    configService = module.get(ConfigService);
  });

  describe('getAuthorizationUrl', () => {
    it('should build the Google consent URL with client_id, redirect_uri, state and scope', () => {
      configService.getOrThrow.mockReturnValue('google-client-id');

      const url = new URL(
        client.getAuthorizationUrl(
          'state-123',
          'https://api.liyanza.com/auth/google/callback',
        ),
      );

      expect(url.origin + url.pathname).toBe(
        'https://accounts.google.com/o/oauth2/v2/auth',
      );
      expect(url.searchParams.get('client_id')).toBe('google-client-id');
      expect(url.searchParams.get('redirect_uri')).toBe(
        'https://api.liyanza.com/auth/google/callback',
      );
      expect(url.searchParams.get('state')).toBe('state-123');
      expect(url.searchParams.get('response_type')).toBe('code');
      // access_type=offline volontairement absent : ce client ne sert qu'à
      // résoudre l'identité une seule fois, jamais à rappeler l'API Google.
      expect(url.searchParams.has('access_type')).toBe(false);
    });
  });

  describe('exchangeCodeForProfile', () => {
    it('should exchange the code then fetch the userinfo endpoint and map the profile', async () => {
      http.post.mockReturnValue(
        of(
          axiosResponse({
            access_token: 'google-access-token',
            id_token: 'id-token',
            token_type: 'Bearer',
            expires_in: 3600,
          }),
        ),
      );
      http.get.mockReturnValue(
        of(
          axiosResponse({
            sub: 'google-sub-1',
            email: 'user@gmail.com',
            given_name: 'Ada',
            family_name: 'Lovelace',
          }),
        ),
      );

      const profile = await client.exchangeCodeForProfile(
        'auth-code',
        'https://api.liyanza.com/auth/google/callback',
      );

      expect(profile).toEqual({
        providerId: 'google-sub-1',
        email: 'user@gmail.com',
        firstName: 'Ada',
        lastName: 'Lovelace',
      });
      expect(http.get).toHaveBeenCalledWith(expect.any(String), {
        headers: { Authorization: 'Bearer google-access-token' },
      });
    });

    it('should throw if Google does not return an email', async () => {
      http.post.mockReturnValue(
        of(
          axiosResponse({
            access_token: 'tok',
            id_token: 'i',
            token_type: 'Bearer',
            expires_in: 1,
          }),
        ),
      );
      http.get.mockReturnValue(of(axiosResponse({ sub: 'google-sub-2' })));

      await expect(
        client.exchangeCodeForProfile('code', 'https://cb'),
      ).rejects.toThrow('Google account has no email associated.');
    });

    it('should wrap an Axios error from the token endpoint into a descriptive Error', async () => {
      const axiosError = new AxiosError('Request failed');
      axiosError.response = axiosResponse({
        error_description: 'invalid_grant',
      }) as AxiosResponse;
      http.post.mockReturnValue(throwError(() => axiosError));

      await expect(
        client.exchangeCodeForProfile('bad-code', 'https://cb'),
      ).rejects.toThrow(/invalid_grant/);
    });
  });

  // BACK-507 — Connexion Google depuis l'app mobile (idToken natif), DISTINCT
  // du flow ci-dessus (code + redirect_uri).
  describe('verifyIdToken', () => {
    const mockVerifyIdToken = OAuth2Client.prototype.verifyIdToken as jest.Mock;

    beforeEach(() => {
      mockVerifyIdToken.mockReset();
    });

    it('should verify the token against the web GOOGLE_CLIENT_ID (the serverClientId configured on the app) and map the payload', async () => {
      configService.getOrThrow.mockImplementation((key: string) =>
        key === 'GOOGLE_CLIENT_ID' ? 'web-client-id' : `config:${key}`,
      );
      mockVerifyIdToken.mockResolvedValue({
        getPayload: () => ({
          sub: 'google-sub-9',
          email: 'mobile-user@gmail.com',
          email_verified: true,
          given_name: 'Grace',
          family_name: 'Hopper',
        }),
      });

      const profile = await client.verifyIdToken('id-token-value');

      expect(mockVerifyIdToken).toHaveBeenCalledWith({
        idToken: 'id-token-value',
        audience: 'web-client-id',
      });
      expect(profile).toEqual({
        providerId: 'google-sub-9',
        email: 'mobile-user@gmail.com',
        firstName: 'Grace',
        lastName: 'Hopper',
      });
    });

    it('should wrap a signature/audience verification failure into a generic error', async () => {
      mockVerifyIdToken.mockRejectedValue(
        new Error('Wrong number of segments'),
      );

      await expect(client.verifyIdToken('bad-token')).rejects.toThrow(
        'Invalid Google idToken.',
      );
    });

    it('should reject an account whose Google email is not verified', async () => {
      mockVerifyIdToken.mockResolvedValue({
        getPayload: () => ({
          sub: 'google-sub-10',
          email: 'unverified@gmail.com',
          email_verified: false,
        }),
      });

      await expect(client.verifyIdToken('id-token-value')).rejects.toThrow(
        'Google account email is not verified.',
      );
    });
  });
});
