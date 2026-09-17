import { Test, TestingModule } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { of, throwError } from 'rxjs';
import { AxiosError, type AxiosResponse } from 'axios';
import { GoogleOAuthClient } from './google-oauth.client';

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
});
