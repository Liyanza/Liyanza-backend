import { computePageHealth } from './page-health';
import type {
  DailyValue,
  RawPageHealth,
  RawPagePost,
} from '../clients/meta-page.client';

const NOW = new Date('2026-09-26T10:00:00Z');

/** Série de `days` jours se terminant hier, valeur constante. */
function series(days: number, value: number, offsetDays = 0): DailyValue[] {
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(NOW.getTime() - (i + 1 + offsetDays) * 86400000);
    return { date: d.toISOString().slice(0, 10), value };
  });
}

function post(
  createdTime: string,
  reactions: number,
  comments = 0,
  shares = 0,
  message = 'Post',
): RawPagePost {
  return {
    id: `p-${createdTime}-${reactions}`,
    message,
    created_time: createdTime,
    reactions: { summary: { total_count: reactions } },
    comments: { summary: { total_count: comments } },
    shares: { count: shares },
  };
}

const raw = (overrides: Partial<RawPageHealth> = {}): RawPageHealth => ({
  name: 'Nexclean',
  followers: 1000,
  views: [...series(28, 100), ...series(28, 80, 28)],
  engagement: [...series(28, 10), ...series(28, 10, 28)],
  newFollowers: series(28, 2),
  posts: [],
  ...overrides,
});

describe('computePageHealth', () => {
  it('should compare the last 28 days with the previous 28', () => {
    const health = computePageHealth(raw(), NOW);
    const byKey = Object.fromEntries(health.kpis.map((k) => [k.key, k]));

    expect(byKey.views).toMatchObject({
      current: 2800,
      previous: 2240,
      change: 0.25,
    });
    expect(byKey.engagement).toMatchObject({ change: 0 });
    // Pas de période précédente : pas de variation.
    expect(byKey.newFollowers).toMatchObject({
      current: 56,
      previous: null,
      change: null,
    });
    expect(health.series).toHaveLength(28);
    expect(health.series[27]).toEqual({
      date: '2026-09-25',
      views: 100,
      engagement: 10,
    });
  });

  it('should find the best posting slots in Douala time, with enough posts only', () => {
    const posts = [
      // Mardi 18h-21h (UTC 17h-20h) : 3 publications très engageantes.
      post('2026-09-22T17:30:00+0000', 90, 6, 4),
      post('2026-09-15T18:10:00+0000', 70, 5, 5),
      post('2026-09-08T19:00:00+0000', 80, 10, 0),
      // Lundi 9h-12h : 3 publications moyennes.
      post('2026-09-21T08:30:00+0000', 20),
      post('2026-09-14T09:00:00+0000', 30),
      post('2026-09-07T10:00:00+0000', 25),
      // Samedi, une seule publication record : pas assez pour recommander.
      post('2026-09-19T11:00:00+0000', 500),
      // Dimanche 23h UTC = lundi 0h à Douala.
      post('2026-09-20T23:30:00+0000', 5),
      post('2026-09-13T23:10:00+0000', 5),
    ];

    const health = computePageHealth(raw({ posts }), NOW);

    expect(health.bestTimes.enough).toBe(true);
    expect(health.bestTimes.top[0]).toMatchObject({
      weekday: 1, // mardi
      slot: 6, // 18h-21h
      posts: 3,
      avgInteractions: 90,
    });
    expect(health.bestTimes.top.map((s) => s.weekday)).not.toContain(5);
    expect(
      health.bestTimes.slots.find((s) => s.weekday === 0 && s.slot === 0),
    ).toMatchObject({ posts: 2 });
    // Meilleure publication : le record du samedi.
    expect(health.topPosts[0]).toMatchObject({ interactions: 500 });
    expect(health.avgInteractionsPerPost).toBe(95);
    expect(health.engagementRate).toBe(9.5);
    expect(health.postsInPeriod).toBe(9);
    expect(health.postsPerWeek).toBe(2.3);
  });

  it('should not recommend slots with too few posts, and survive missing metrics', () => {
    const health = computePageHealth(
      raw({
        followers: null,
        views: [],
        engagement: [],
        newFollowers: [],
        posts: [post('2026-09-22T17:30:00+0000', 10)],
      }),
      NOW,
    );

    expect(health.bestTimes).toMatchObject({
      enough: false,
      top: [],
      sampleSize: 1,
    });
    expect(health.kpis.every((k) => k.current === null)).toBe(true);
    expect(health.engagementRate).toBeNull();
    expect(health.series).toEqual([]);
  });
});
