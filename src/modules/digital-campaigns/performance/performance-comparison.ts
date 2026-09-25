import { DigitalObjective } from '@prisma/client';
import type {
  MetaAction,
  MetaCampaignInsights,
  MetaInsightsRow,
} from '../../social-accounts/clients/meta-ads.client';
import type { DigitalSimulationScenarioSnapshot } from '../clients/digital-simulation-engine.interface';

/**
 * « Prévu vs réel » : résultats réels d'une campagne Facebook Ads comparés à
 * sa dernière simulation. Fonctions pures (aucun accès réseau/BDD), testées
 * dans performance-comparison.spec.ts.
 *
 * Les prévisions portent sur toute la campagne : un volume (portée, clics,
 * conversions) est comparé à ce qu'il devrait valoir AU RYTHME ACTUEL — la
 * part du budget déjà dépensée, ou à défaut la part du temps écoulé. Les
 * taux et coûts unitaires (CTR, CPC, CPA, ROAS) se comparent directement.
 */

export type MetricKey =
  'reach' | 'clicks' | 'conversions' | 'ctr' | 'cpc' | 'cpa' | 'roas';

export type MetricStatus = 'ahead' | 'on_track' | 'behind' | 'unknown';

export interface MetricComparison {
  key: MetricKey;
  kind: 'volume' | 'rate' | 'cost';
  /** Prévision de la simulation (sur toute la campagne pour un volume). */
  predicted: number | null;
  /** Volume attendu à ce stade (prévision × avancement) ; = predicted pour un taux. */
  expected: number | null;
  actual: number | null;
  /** Performance relative : > 1 = mieux que prévu (inversé pour un coût). */
  performance: number | null;
  status: MetricStatus;
}

export interface DailyPoint {
  date: string;
  spend: number;
  reach: number;
  impressions: number;
  clicks: number;
  conversions: number;
}

export interface PerformanceComparison {
  /** Devise du compte publicitaire Meta. */
  currency: string;
  /** Dépense convertie en FCFA ; null si la devise n'est pas convertible. */
  spendXaf: number | null;
  spend: number;
  plannedBudget: number;
  /** Part du budget dépensée (0-1) ; null si la devise n'est pas convertible. */
  spendProgress: number | null;
  /** Part de la durée de la campagne écoulée (0-1). */
  timeProgress: number;
  /** Avancement retenu pour les volumes. */
  progress: number;
  /** Moins de 10 % d'avancement : écarts peu significatifs. */
  tooEarly: boolean;
  /** Type d'action Meta compté comme conversion (null : aucune trouvée). */
  conversionAction: string | null;
  metrics: MetricComparison[];
  daily: DailyPoint[];
}

export interface SimulationForComparison {
  predictedReach: number | null;
  predictedCtr: number | null;
  predictedRoas: number | null;
  avgCpc: number | null;
  costPerAcquisition: number | null;
  scenarios: unknown;
}

/** Taux fixes vers le FCFA (XAF). XOF : même parité ; EUR : parité fixe. */
const XAF_RATES: Record<string, number> = { XAF: 1, XOF: 1, EUR: 655.957 };

const PURCHASE_ACTIONS = [
  'omni_purchase',
  'purchase',
  'offsite_conversion.fb_pixel_purchase',
];
const LEAD_ACTIONS = [
  'lead',
  'onsite_conversion.lead_grouped',
  'offsite_conversion.fb_pixel_lead',
];
const MESSAGING_ACTIONS = [
  'onsite_conversion.messaging_conversation_started_7d',
];

/** Actions comptées comme conversions, par ordre de préférence selon l'objectif. */
const CONVERSION_ACTIONS: Record<DigitalObjective, string[]> = {
  SALES: [...PURCHASE_ACTIONS, ...LEAD_ACTIONS, ...MESSAGING_ACTIONS],
  CONVERSION: [...PURCHASE_ACTIONS, ...LEAD_ACTIONS, ...MESSAGING_ACTIONS],
  LEADS: [...LEAD_ACTIONS, ...MESSAGING_ACTIONS, ...PURCHASE_ACTIONS],
  AWARENESS: [...MESSAGING_ACTIONS, ...LEAD_ACTIONS, ...PURCHASE_ACTIONS],
  ENGAGEMENT: [...MESSAGING_ACTIONS, ...LEAD_ACTIONS, ...PURCHASE_ACTIONS],
  TRAFFIC: [...MESSAGING_ACTIONS, ...LEAD_ACTIONS, ...PURCHASE_ACTIONS],
};

const num = (value: string | undefined) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

function actionValue(actions: MetaAction[] | undefined, type: string) {
  const found = actions?.find((a) => a.action_type === type);
  return found ? num(found.value) : null;
}

/** Première action de la liste présente dans les résultats. */
export function pickConversionAction(
  objective: DigitalObjective,
  actions: MetaAction[] | undefined,
): string | null {
  return (
    CONVERSION_ACTIONS[objective].find(
      (type) => actionValue(actions, type) !== null,
    ) ?? null
  );
}

const clicksOf = (row: MetaInsightsRow) =>
  row.inline_link_clicks !== undefined
    ? num(row.inline_link_clicks)
    : num(row.clicks);

function recommendedScenario(
  scenarios: unknown,
): DigitalSimulationScenarioSnapshot | null {
  if (!Array.isArray(scenarios)) return null;
  const list = scenarios as DigitalSimulationScenarioSnapshot[];
  return list.find((s) => s.isRecommended) ?? list[0] ?? null;
}

function statusOf(performance: number | null): MetricStatus {
  if (performance === null || !Number.isFinite(performance)) return 'unknown';
  if (performance >= 1.1) return 'ahead';
  if (performance >= 0.85) return 'on_track';
  return 'behind';
}

const round = (n: number, digits = 2) => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

export function comparePerformance(input: {
  objective: DigitalObjective;
  plannedBudget: number;
  startDate: Date;
  endDate: Date;
  now: Date;
  currency: string;
  insights: MetaCampaignInsights;
  simulation: SimulationForComparison | null;
}): PerformanceComparison {
  const { insights, simulation } = input;
  const totals = insights.totals;
  const rate = XAF_RATES[input.currency.toUpperCase()] ?? null;

  const spend = totals ? num(totals.spend) : 0;
  const spendXaf = rate !== null ? spend * rate : null;
  const duration = input.endDate.getTime() - input.startDate.getTime();
  const elapsed = input.now.getTime() - input.startDate.getTime();
  const timeProgress =
    duration > 0 ? Math.min(1, Math.max(0, elapsed / duration)) : 1;
  const spendProgress =
    spendXaf !== null && input.plannedBudget > 0
      ? Math.min(1, spendXaf / input.plannedBudget)
      : null;
  // La dépense reflète mieux l'avancement réel (campagne en pause, lancée
  // en retard…) ; le temps écoulé sert de repli.
  const progress =
    spendProgress !== null && spendProgress > 0 ? spendProgress : timeProgress;

  const conversionAction = pickConversionAction(
    input.objective,
    totals?.actions,
  );
  const reach = totals ? num(totals.reach) : null;
  const clicks = totals ? clicksOf(totals) : null;
  const impressions = totals ? num(totals.impressions) : 0;
  const conversions =
    totals && conversionAction
      ? actionValue(totals.actions, conversionAction)
      : totals
        ? 0
        : null;
  const purchaseValue = totals
    ? (PURCHASE_ACTIONS.map((t) => actionValue(totals.action_values, t)).find(
        (v) => v !== null,
      ) ?? null)
    : null;

  const scenario = recommendedScenario(simulation?.scenarios);
  const predicted: Record<MetricKey, number | null> = {
    reach: simulation?.predictedReach ?? null,
    clicks: scenario?.predictedClicks ?? null,
    conversions: scenario?.predictedConversions ?? null,
    ctr: simulation?.predictedCtr ?? null,
    cpc: simulation?.avgCpc ?? null,
    cpa: simulation?.costPerAcquisition ?? null,
    roas: simulation?.predictedRoas ?? null,
  };
  const actual: Record<MetricKey, number | null> = {
    reach,
    clicks,
    conversions,
    ctr:
      clicks !== null && impressions > 0 ? (clicks / impressions) * 100 : null,
    cpc: spendXaf !== null && clicks ? spendXaf / clicks : null,
    cpa: spendXaf !== null && conversions ? spendXaf / conversions : null,
    roas: purchaseValue !== null && spend > 0 ? purchaseValue / spend : null,
  };
  const kinds: Record<MetricKey, MetricComparison['kind']> = {
    reach: 'volume',
    clicks: 'volume',
    conversions: 'volume',
    ctr: 'rate',
    roas: 'rate',
    cpc: 'cost',
    cpa: 'cost',
  };

  const metrics = (Object.keys(kinds) as MetricKey[]).map((key) => {
    const kind = kinds[key];
    const p = predicted[key];
    const a = actual[key];
    const expected = p === null ? null : kind === 'volume' ? p * progress : p;
    let performance: number | null = null;
    if (a !== null && expected !== null && expected > 0) {
      performance =
        kind === 'cost' ? (a > 0 ? expected / a : null) : a / expected;
    }
    return {
      key,
      kind,
      predicted: p === null ? null : round(p),
      expected: expected === null ? null : round(expected),
      actual: a === null ? null : round(a),
      performance: performance === null ? null : round(performance, 3),
      status: statusOf(performance),
    };
  });

  const daily = insights.daily.map((row) => ({
    date: row.date_start,
    spend: num(row.spend),
    reach: num(row.reach),
    impressions: num(row.impressions),
    clicks: clicksOf(row),
    conversions: conversionAction
      ? (actionValue(row.actions, conversionAction) ?? 0)
      : 0,
  }));

  return {
    currency: input.currency,
    spendXaf: spendXaf === null ? null : round(spendXaf, 0),
    spend: round(spend),
    plannedBudget: input.plannedBudget,
    spendProgress: spendProgress === null ? null : round(spendProgress, 3),
    timeProgress: round(timeProgress, 3),
    progress: round(progress, 3),
    tooEarly: progress < 0.1,
    conversionAction,
    metrics,
    daily,
  };
}
