import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { SocialPlatform } from '@prisma/client';
import { AxiosError, AxiosHeaders } from 'axios';
import { of, throwError } from 'rxjs';
import { MetaGraphClient } from './meta-graph.client';
import { MetaTokenExpiredError } from './meta-graph.errors';

describe('MetaGraphClient.getAccountProfile', () => {
  const get = jest.fn();
  const http = { get } as unknown as HttpService;
  const config = {
    get: jest.fn(() => undefined),
    getOrThrow: jest.fn((key: string) => `config:${key}`),
  } as unknown as ConfigService;
  const client = new MetaGraphClient(http, config);

  /** Réponses Graph API par chemin (suffixe de l'URL appelée). */
  const respond = (routes: Record<string, unknown>) =>
    get.mockImplementation((url: string) => {
      const path = Object.keys(routes).find((p) => url.endsWith(p));
      if (!path) throw new Error(`Unexpected Graph call ${url}`);
      return of({ data: routes[path] });
    });

  beforeEach(() => get.mockReset());

  it('should use the Pages the user manages directly', async () => {
    respond({
      '/me/accounts': {
        data: [{ id: 'p1', name: 'Page 1', access_token: 'page-token' }],
      },
    });

    await expect(
      client.getAccountProfile(SocialPlatform.FACEBOOK, 'user-token'),
    ).resolves.toEqual({
      externalAccountId: 'p1',
      externalAccountName: 'Page 1',
      accessTokenOverride: 'page-token',
    });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('should fall back to business portfolio Pages when /me/accounts is empty', async () => {
    respond({
      '/me/accounts': { data: [] },
      '/me/businesses': { data: [{ id: 'b1' }] },
      '/b1/owned_pages': {
        data: [
          // Sans token de Page, l'utilisateur ne peut pas la gérer : ignorée.
          { id: 'p0', name: 'Not managed' },
          {
            id: 'p2',
            name: 'Business Page',
            access_token: 'page-token-2',
            instagram_business_account: { id: 'ig1' },
          },
        ],
      },
      '/b1/client_pages': { data: [] },
      '/ig1': { username: 'kiyanza' },
    });

    await expect(
      client.getAccountProfile(SocialPlatform.FACEBOOK, 'user-token'),
    ).resolves.toMatchObject({ externalAccountId: 'p2' });
    await expect(
      client.getAccountProfile(SocialPlatform.INSTAGRAM, 'user-token'),
    ).resolves.toEqual({
      externalAccountId: 'ig1',
      externalAccountName: 'kiyanza',
      accessTokenOverride: 'page-token-2',
    });
  });

  it('should still fail clearly when no Page is reachable at all', async () => {
    respond({
      '/me/accounts': { data: [] },
      '/me/businesses': { data: [] },
    });

    await expect(
      client.getAccountProfile(SocialPlatform.FACEBOOK, 'user-token'),
    ).rejects.toThrow('No Facebook Page found');
  });
});

describe('MetaGraphClient Instagram lookup and insights', () => {
  const get = jest.fn();
  const client = new MetaGraphClient(
    { get } as unknown as HttpService,
    {
      get: jest.fn(() => undefined),
      getOrThrow: jest.fn((key: string) => `config:${key}`),
    } as unknown as ConfigService,
  );

  const metaError = (message: string, code: number) =>
    new AxiosError(message, 'ERR', undefined, undefined, {
      status: 400,
      statusText: 'Bad Request',
      headers: {},
      config: { headers: new AxiosHeaders() },
      data: { error: { message, code } },
    });

  beforeEach(() => get.mockReset());

  it('should look for the Instagram account in the portfolio when direct Pages have none', async () => {
    get.mockImplementation((url: string) => {
      if (url.endsWith('/me/accounts'))
        return of({
          data: { data: [{ id: 'p1', name: 'Page', access_token: 't1' }] },
        });
      if (url.endsWith('/me/businesses'))
        return of({ data: { data: [{ id: 'b1' }] } });
      if (url.endsWith('/b1/owned_pages'))
        return of({
          data: {
            data: [
              {
                id: 'p2',
                name: 'Page 2',
                access_token: 't2',
                instagram_business_account: { id: 'ig2' },
              },
            ],
          },
        });
      if (url.endsWith('/b1/client_pages')) return of({ data: { data: [] } });
      if (url.endsWith('/ig2')) return of({ data: { username: 'shop' } });
      throw new Error(`Unexpected ${url}`);
    });

    await expect(
      client.getAccountProfile(SocialPlatform.INSTAGRAM, 'user-token'),
    ).resolves.toEqual({
      externalAccountId: 'ig2',
      externalAccountName: 'shop',
      accessTokenOverride: 't2',
    });
  });

  it('should skip metrics Meta retired (#100) and read total_value metrics', async () => {
    get.mockImplementation(
      (url: string, config: { params: Record<string, string> }) => {
        if (!url.endsWith('/insights'))
          return of({ data: { followers_count: 200 } });
        const { metric } = config.params;
        if (metric === 'views')
          return of({
            data: { data: [{ name: 'views', total_value: { value: 900 } }] },
          });
        if (metric === 'reach')
          return throwError(() =>
            metaError('(#100) The value must be a valid insights metric', 100),
          );
        throw new Error(`Unexpected metric ${metric}`);
      },
    );

    const insights = await client.getInsights(
      SocialPlatform.INSTAGRAM,
      'page-token',
      'ig1',
    );

    expect(insights).toMatchObject({
      followerCount: 200,
      impressions: 900,
      reach: undefined,
      engagementRate: undefined,
    });
  });

  it('should fall back to the legacy metric and still surface other errors', async () => {
    get.mockImplementation(
      (url: string, config: { params: Record<string, string> }) => {
        if (!url.endsWith('/insights'))
          return of({ data: { followers_count: 100 } });
        const { metric } = config.params;
        if (metric === 'page_media_view' || metric === 'page_post_engagements')
          return throwError(() => metaError('invalid metric', 100));
        return of({
          data: { data: [{ name: metric, values: [{ value: 10 }] }] },
        });
      },
    );

    await expect(
      client.getInsights(SocialPlatform.FACEBOOK, 'page-token', 'p1'),
    ).resolves.toMatchObject({ impressions: 10, engagementRate: 10 });

    get.mockImplementation((url: string) =>
      url.endsWith('/insights')
        ? throwError(() => metaError('Session has expired', 190))
        : of({ data: { followers_count: 100 } }),
    );
    await expect(
      client.getInsights(SocialPlatform.FACEBOOK, 'page-token', 'p1'),
    ).rejects.toBeInstanceOf(MetaTokenExpiredError);
  });
});
