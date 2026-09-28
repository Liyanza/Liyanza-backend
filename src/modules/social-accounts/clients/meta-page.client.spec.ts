import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { AxiosError, AxiosHeaders } from 'axios';
import { Observable, of, throwError } from 'rxjs';
import { MetaPageClient } from './meta-page.client';
import { MetaTokenExpiredError } from './meta-graph.errors';

const metaError = (message: string, code: number) =>
  throwError(
    () =>
      new AxiosError(message, 'ERR', undefined, undefined, {
        status: 400,
        statusText: 'Bad Request',
        headers: {},
        config: { headers: new AxiosHeaders() },
        data: { error: { message, code } },
      }),
  );

const USER_CONTENT_ERROR =
  "(#10) This endpoint requires the 'pages_read_user_content' permission";

describe('MetaPageClient.getPageHealth', () => {
  const get = jest.fn();
  const client = new MetaPageClient(
    { get } as unknown as HttpService,
    { get: jest.fn(() => undefined) } as unknown as ConfigService,
  );

  /** Page et statistiques OK ; `posts(fields)` décide de la réponse des publications. */
  const respond = (posts: (fields: string) => Observable<unknown>) =>
    get.mockImplementation(
      (url: string, config: { params: Record<string, string> }) => {
        if (url.endsWith('/posts')) return posts(config.params.fields);
        if (url.endsWith('/insights')) return of({ data: { data: [] } });
        return of({ data: { name: 'Nexclean', followers_count: 1043 } });
      },
    );

  beforeEach(() => get.mockReset());

  it('should read posts with comments when the permission is granted', async () => {
    respond(() => of({ data: { data: [{ id: 'p1', created_time: 'x' }] } }));

    const health = await client.getPageHealth('token', 'page-1');

    expect(health).toMatchObject({
      name: 'Nexclean',
      followers: 1043,
      postsAccess: 'full',
      posts: [{ id: 'p1' }],
    });
  });

  it('should retry without comments, then without reactions, when Meta refuses user content', async () => {
    respond((fields) =>
      fields.includes('comments') || fields.includes('reactions')
        ? metaError(USER_CONTENT_ERROR, 10)
        : of({ data: { data: [{ id: 'p1', created_time: 'x' }] } }),
    );

    const health = await client.getPageHealth('token', 'page-1');

    expect(health.postsAccess).toBe('basic');
    expect(health.posts).toHaveLength(1);
    expect(health.followers).toBe(1043);
  });

  it('should still return the Page statistics when posts are not readable at all', async () => {
    respond(() => metaError(USER_CONTENT_ERROR, 10));

    await expect(
      client.getPageHealth('token', 'page-1'),
    ).resolves.toMatchObject({
      followers: 1043,
      posts: [],
      postsAccess: 'none',
    });
  });

  it('should still surface an expired token', async () => {
    respond(() => metaError('Session has expired', 190));

    await expect(
      client.getPageHealth('token', 'page-1'),
    ).rejects.toBeInstanceOf(MetaTokenExpiredError);
  });
});
