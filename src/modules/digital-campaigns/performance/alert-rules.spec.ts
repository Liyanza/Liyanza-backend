import { detectAlerts } from './alert-rules';
import type {
  MetricComparison,
  PerformanceComparison,
} from './performance-comparison';
import type { MetaCampaignInsights } from '../../social-accounts/clients/meta-ads.client';

const metric = (
  key: MetricComparison['key'],
  values: Partial<MetricComparison>,
): MetricComparison => ({
  key,
  kind: 'volume',
  predicted: null,
  expected: null,
  actual: null,
  performance: null,
  status: 'unknown',
  ...values,
});

const comparison = (
  overrides: Partial<PerformanceComparison> = {},
): PerformanceComparison => ({
  currency: 'XAF',
  spendXaf: 30000,
  spend: 30000,
  plannedBudget: 100000,
  spendProgress: 0.3,
  timeProgress: 0.3,
  progress: 0.3,
  tooEarly: false,
  conversionAction: null,
  metrics: [],
  daily: [],
  ...overrides,
});

const noInsights: MetaCampaignInsights = { totals: null, daily: [] };
const types = (c: PerformanceComparison, i = noInsights) =>
  detectAlerts(c, i).map((a) => a.type);

describe('detectAlerts', () => {
  it('should raise nothing for a campaign on track', () => {
    expect(types(comparison())).toEqual([]);
  });

  it('should detect a budget spent too fast, critical when almost exhausted', () => {
    const [alert] = detectAlerts(
      comparison({ spendProgress: 0.7, timeProgress: 0.4 }),
      noInsights,
    );
    expect(alert).toEqual({
      type: 'BUDGET_PACING_FAST',
      severity: 'WARNING',
      data: { spendPct: 70, timePct: 40 },
    });
    expect(
      detectAlerts(
        comparison({ spendProgress: 0.97, timeProgress: 0.6 }),
        noInsights,
      )[0].severity,
    ).toBe('CRITICAL');
    // Fin de campagne : dépenser le budget est normal.
    expect(types(comparison({ spendProgress: 1, timeProgress: 0.92 }))).toEqual(
      [],
    );
  });

  it('should detect under-delivery only after 30 % of the duration', () => {
    expect(
      types(comparison({ spendProgress: 0.1, timeProgress: 0.5 })),
    ).toEqual(['BUDGET_PACING_SLOW']);
    expect(types(comparison({ spendProgress: 0, timeProgress: 0.2 }))).toEqual(
      [],
    );
  });

  it('should detect a high cost per click with enough clicks', () => {
    const c = comparison({
      metrics: [
        metric('clicks', { actual: 40 }),
        metric('cpc', {
          kind: 'cost',
          predicted: 100,
          actual: 180,
          performance: 0.556,
        }),
      ],
    });
    expect(detectAlerts(c, noInsights)).toEqual([
      {
        type: 'CPC_HIGH',
        severity: 'WARNING',
        data: { actualCpc: 180, predictedCpc: 100 },
      },
    ]);
    // Trop peu de clics : pas encore significatif.
    const few = comparison({
      metrics: [
        metric('clicks', { actual: 12 }),
        metric('cpc', {
          kind: 'cost',
          predicted: 100,
          actual: 300,
          performance: 0.33,
        }),
      ],
    });
    expect(types(few)).toEqual([]);
  });

  it('should detect a low click-through rate once there are enough impressions', () => {
    const c = comparison({
      metrics: [
        metric('ctr', {
          kind: 'rate',
          predicted: 1,
          actual: 0.4,
          performance: 0.4,
        }),
      ],
    });
    const insights = {
      totals: { date_start: 'a', date_stop: 'b', impressions: '8000' },
      daily: [],
    };
    expect(types(c, insights)).toEqual(['CTR_LOW']);
    expect(
      types(c, {
        ...insights,
        totals: { ...insights.totals, impressions: '900' },
      }),
    ).toEqual([]);
  });

  it('should detect audience fatigue from frequency and a falling CTR', () => {
    const day = (i: number, clicks: number) => ({
      date_start: `2026-09-0${i}`,
      date_stop: `2026-09-0${i}`,
      impressions: '1000',
      inline_link_clicks: String(clicks),
    });
    const insights = {
      totals: {
        date_start: 'a',
        date_stop: 'b',
        frequency: '3.6',
        impressions: '6000',
      },
      daily: [
        day(1, 20),
        day(2, 20),
        day(3, 20),
        day(4, 12),
        day(5, 10),
        day(6, 8),
      ],
    };

    expect(detectAlerts(comparison(), insights)).toEqual([
      {
        type: 'AUDIENCE_FATIGUE',
        severity: 'WARNING',
        data: { frequency: 3.6, ctrDropPct: 50 },
      },
    ]);
    // Fréquence faible : pas de lassitude.
    expect(
      types(comparison(), {
        ...insights,
        totals: { ...insights.totals, frequency: '1.4' },
      }),
    ).toEqual([]);
  });

  it('should flag zero conversions when several were expected', () => {
    const c = comparison({
      progress: 0.5,
      metrics: [metric('conversions', { actual: 0, expected: 4.2 })],
    });
    expect(detectAlerts(c, noInsights)).toEqual([
      { type: 'NO_CONVERSIONS', severity: 'CRITICAL', data: { expected: 4 } },
    ]);
  });

  it('should only check budget pacing while the campaign has just started', () => {
    const c = comparison({
      tooEarly: true,
      spendProgress: 0.35,
      timeProgress: 0.05,
      metrics: [
        metric('clicks', { actual: 40 }),
        metric('cpc', {
          kind: 'cost',
          predicted: 100,
          actual: 300,
          performance: 0.33,
        }),
      ],
    });
    expect(types(c)).toEqual(['BUDGET_PACING_FAST']);
  });
});
