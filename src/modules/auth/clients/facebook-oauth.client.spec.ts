import { Test, TestingModule } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { of, throwError } from 'rxjs';
import { AxiosError, type AxiosResponse } from 'axios';
import { FacebookOAuthClient } from './facebook-oauth.client';

function axiosResponse<T>(data: T): AxiosResponse<T> {
  return {
    data,
    status: 200,
    statusText: 'OK',
    headers: {},
    config: {} as AxiosResponse['config'],
  };
}

describe('FacebookOAuthClient', () => {
  let client: FacebookOAuthClient;
  let http: { get: jest.Mock };
  let configService: { get: jest.Mock; getOrThrow: jest.Mock };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FacebookOAuthClient,
        { provide: HttpService, useValue: { get: jest.fn() } },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(),
            getOrThrow: jest.fn((key: string) => `config:${key}`),
          },
        },
      ],
    }).compile();

    client = module.get(FacebookOAuthClient);
    http = module.get(HttpService);
    configService = module.get(ConfigService);
  });

  describe('getAuthorizationUrl', () => {
    it('should build the Facebook consent URL with the email+public_profile scope', () => {
      configService.getOrThrow.mockReturnValue('meta-app-id');

      const url = new URL(
        client.getAuthorizationUrl(
          'state-123',
          'https://api.liyanza.com/auth/facebook/callback',
        ),
      );

      expect(url.searchParams.get('client_id')).toBe('meta-app-id');
      expect(url.searchParams.get('scope')).toBe('email,public_profile');
      expect(url.searchParams.get('state')).toBe('state-123');
    });

    it('should use the dedicated login App when FACEBOOK_LOGIN_APP_ID/SECRET are set', async () => {
      configService.get.mockImplementation(
        (key: string) =>
          ({
            FACEBOOK_LOGIN_APP_ID: 'login-app-id',
            FACEBOOK_LOGIN_APP_SECRET: 'login-app-secret',
          })[key],
      );

      const url = new URL(
        client.getAuthorizationUrl(
          'state-123',
          'https://api.liyanza.com/auth/facebook/callback',
        ),
      );
      expect(url.searchParams.get('client_id')).toBe('login-app-id');

      http.get
        .mockReturnValueOnce(of(axiosResponse({ access_token: 'token' })))
        .mockReturnValueOnce(
          of(axiosResponse({ id: 'fb-id', email: 'user@example.com' })),
        );
      await client.exchangeCodeForProfile(
        'auth-code',
        'https://api.liyanza.com/auth/facebook/callback',
      );
      expect(http.get).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('/oauth/access_token'),
        {
          params: expect.objectContaining({
            client_id: 'login-app-id',
            client_secret: 'login-app-secret',
          }) as Record<string, string>,
        },
      );
      expect(configService.getOrThrow).not.toHaveBeenCalledWith('META_APP_ID');
    });
  });

  describe('exchangeCodeForProfile', () => {
    it('should exchange the code then fetch /me and map the profile', async () => {
      http.get
        .mockReturnValueOnce(
          of(axiosResponse({ access_token: 'fb-access-token' })),
        )
        .mockReturnValueOnce(
          of(
            axiosResponse({
              id: 'fb-id-1',
              email: 'user@example.com',
              first_name: 'Grace',
              last_name: 'Hopper',
            }),
          ),
        );

      const profile = await client.exchangeCodeForProfile(
        'auth-code',
        'https://api.liyanza.com/auth/facebook/callback',
      );

      expect(profile).toEqual({
        providerId: 'fb-id-1',
        email: 'user@example.com',
        firstName: 'Grace',
        lastName: 'Hopper',
      });
    });

    // Cas attendu (utilisateur sans email vérifié / permission refusée) —
    // ne doit jamais créer de compte sans identifiant unique exploitable.
    it('should throw if Facebook does not return an email', async () => {
      http.get
        .mockReturnValueOnce(
          of(axiosResponse({ access_token: 'fb-access-token' })),
        )
        .mockReturnValueOnce(
          of(
            axiosResponse({
              id: 'fb-id-2',
              first_name: 'No',
              last_name: 'Email',
            }),
          ),
        );

      await expect(
        client.exchangeCodeForProfile('code', 'https://cb'),
      ).rejects.toThrow('Facebook account has no email associated.');
    });

    it('should wrap a Graph API error response into a descriptive Error', async () => {
      const axiosError = new AxiosError('Request failed');
      axiosError.response = axiosResponse({
        error: { message: 'Invalid verification code format.' },
      }) as AxiosResponse;
      http.get.mockReturnValueOnce(throwError(() => axiosError));

      await expect(
        client.exchangeCodeForProfile('bad-code', 'https://cb'),
      ).rejects.toThrow(/Invalid verification code format/);
    });
  });
});
