import type {
  DailyValue,
  RawPageHealth,
  RawPagePost,
} from '../clients/meta-page.client';

/**
 * Santé d'une Page Facebook, calculée à partir des données brutes de Meta.
 * Fonctions pures (testées dans page-health.spec.ts).
 */

export const PERIOD_DAYS = 28;
/** Heure du Cameroun (UTC+1, sans heure d'été). */
const DOUALA_OFFSET_MS = 60 * 60 * 1000;
/** Créneaux de 3 h : 0 = 0h-3h … 7 = 21h-24h. */
export const SLOT_HOURS = 3;
/** Nombre minimal de publications pour recommander des créneaux. */
const MIN_POSTS_FOR_SLOTS = 8;
/** Nombre minimal de publications dans un créneau pour le recommander. */
const MIN_POSTS_PER_SLOT = 2;

export type KpiKey = 'views' | 'engagement' | 'newFollowers';

export interface Kpi {
  key: KpiKey;
  current: number | null;
  previous: number | null;
  /** Variation relative (0,12 = +12 %) ; null sans période précédente. */
  change: number | null;
}

export interface TopPost {
  id: string;
  message: string;
  createdTime: string;
  permalink: string | null;
  picture: string | null;
  reactions: number;
  comments: number;
  shares: number;
  interactions: number;
}

export interface PostingSlot {
  /** 0 = lundi … 6 = dimanche. */
  weekday: number;
  /** Créneau de 3 h (0 = 0h-3h … 7 = 21h-24h), heure de Douala. */
  slot: number;
  posts: number;
  avgInteractions: number;
}

export interface PageHealth {
  pageName: string;
  followers: number | null;
  periodDays: number;
  kpis: Kpi[];
  /** Série quotidienne des 28 derniers jours. */
  series: { date: string; views: number | null; engagement: number | null }[];
  postsInPeriod: number;
  postsPerWeek: number;
  /** Moyenne d'interactions par publication (100 dernières au plus). */
  avgInteractionsPerPost: number | null;
  /** Interactions moyennes rapportées aux abonnés, en %. */
  engagementRate: number | null;
  topPosts: TopPost[];
  bestTimes: {
    /** Publications analysées. */
    sampleSize: number;
    /** false : trop peu de publications pour conclure. */
    enough: boolean;
    top: PostingSlot[];
    /** Tous les créneaux ayant au moins une publication. */
    slots: PostingSlot[];
  };
}

const interactionsOf = (post: RawPagePost) =>
  (post.reactions?.summary?.total_count ?? 0) +
  (post.comments?.summary?.total_count ?? 0) +
  (post.shares?.count ?? 0);

const round = (n: number, digits = 1) => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

/** Somme d'une série sur [from, to[ jours avant `now` (null si aucun point). */
function sumWindow(series: DailyValue[], now: Date, from: number, to: number) {
  const start = now.getTime() - to * 86400000;
  const end = now.getTime() - from * 86400000;
  const points = series.filter((p) => {
    const t = new Date(`${p.date}T12:00:00Z`).getTime();
    return t > start && t <= end;
  });
  return points.length ? points.reduce((s, p) => s + p.value, 0) : null;
}

function kpi(key: KpiKey, series: DailyValue[], now: Date): Kpi {
  const current = sumWindow(series, now, 0, PERIOD_DAYS);
  const previous = sumWindow(series, now, PERIOD_DAYS, PERIOD_DAYS * 2);
  return {
    key,
    current,
    previous,
    change:
      current !== null && previous
        ? round((current - previous) / previous, 3)
        : null,
  };
}

export function computePageHealth(raw: RawPageHealth, now: Date): PageHealth {
  const periodStart = now.getTime() - PERIOD_DAYS * 86400000;
  const posts = raw.posts;
  const postsInPeriod = posts.filter(
    (p) => new Date(p.created_time).getTime() >= periodStart,
  ).length;
  const totalInteractions = posts.reduce((s, p) => s + interactionsOf(p), 0);
  const avgInteractionsPerPost = posts.length
    ? round(totalInteractions / posts.length)
    : null;

  // Série des 28 derniers jours (vues et interactions alignées par date).
  const byDate = new Map<
    string,
    { views: number | null; engagement: number | null }
  >();
  const recent = (p: DailyValue) =>
    new Date(`${p.date}T12:00:00Z`).getTime() > periodStart;
  raw.views
    .filter(recent)
    .forEach((p) => byDate.set(p.date, { views: p.value, engagement: null }));
  raw.engagement.filter(recent).forEach((p) =>
    byDate.set(p.date, {
      views: byDate.get(p.date)?.views ?? null,
      engagement: p.value,
    }),
  );

  // Meilleurs créneaux : interactions moyennes par (jour, tranche de 3 h).
  const slotMap = new Map<string, PostingSlot & { total: number }>();
  for (const post of posts) {
    const local = new Date(
      new Date(post.created_time).getTime() + DOUALA_OFFSET_MS,
    );
    const weekday = (local.getUTCDay() + 6) % 7;
    const slot = Math.floor(local.getUTCHours() / SLOT_HOURS);
    const key = `${weekday}:${slot}`;
    const entry = slotMap.get(key) ?? {
      weekday,
      slot,
      posts: 0,
      avgInteractions: 0,
      total: 0,
    };
    entry.posts += 1;
    entry.total += interactionsOf(post);
    slotMap.set(key, entry);
  }
  const slots = [...slotMap.values()]
    .map(({ total, ...s }) => ({
      ...s,
      avgInteractions: round(total / s.posts),
    }))
    .sort((a, b) => a.weekday - b.weekday || a.slot - b.slot);
  const enough = posts.length >= MIN_POSTS_FOR_SLOTS;
  const top = enough
    ? slots
        .filter((s) => s.posts >= MIN_POSTS_PER_SLOT && s.avgInteractions > 0)
        .sort((a, b) => b.avgInteractions - a.avgInteractions)
        .slice(0, 3)
    : [];

  return {
    pageName: raw.name,
    followers: raw.followers,
    periodDays: PERIOD_DAYS,
    kpis: [
      kpi('views', raw.views, now),
      kpi('engagement', raw.engagement, now),
      kpi('newFollowers', raw.newFollowers, now),
    ],
    series: [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({ date, ...v })),
    postsInPeriod,
    postsPerWeek: round((postsInPeriod / PERIOD_DAYS) * 7),
    avgInteractionsPerPost,
    engagementRate:
      avgInteractionsPerPost !== null && raw.followers
        ? round((avgInteractionsPerPost / raw.followers) * 100, 2)
        : null,
    topPosts: [...posts]
      .sort((a, b) => interactionsOf(b) - interactionsOf(a))
      .slice(0, 5)
      .map((p) => ({
        id: p.id,
        message: (p.message ?? '').slice(0, 280),
        createdTime: p.created_time,
        permalink: p.permalink_url ?? null,
        picture: p.full_picture ?? null,
        reactions: p.reactions?.summary?.total_count ?? 0,
        comments: p.comments?.summary?.total_count ?? 0,
        shares: p.shares?.count ?? 0,
        interactions: interactionsOf(p),
      })),
    bestTimes: { sampleSize: posts.length, enough, top, slots },
  };
}
