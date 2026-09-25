import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { SocialPlatform } from '@prisma/client';
import { of } from 'rxjs';
import { MetaGraphClient } from './meta-graph.client';

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
