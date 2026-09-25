import { DigitalObjective } from '@prisma/client';
import {
  comparePerformance,
  pickConversionAction,
} from './performance-comparison';

describe('comparePerformance', () => {
  const simulation = {
    predictedReach: 10000,
    predictedCtr: 1,
    predictedRoas: 2,
    avgCpc: 100,
    costPerAcquisition: 5000,
    scenarios: [
      {
        id: 'b',
        isRecommended: false,
        predictedClicks: 1,
        predictedConversions: 1,
      },
      {
        id: 'a',
        isRecommended: true,
        predictedClicks: 400,
        predictedConversions: 20,
      },
    ],
  };
  const base = {
    objective: DigitalObjective.SALES,
    plannedBudget: 100000,
    startDate: new Date('2026-10-01T00:00:00Z'),
    endDate: new Date('2026-10-11T00:00:00Z'),
    now: new Date('2026-10-06T00:00:00Z'),
    currency: 'XAF',
    simulation,
  };
  const byKey = (result: ReturnType<typeof comparePerformance>, key: string) =>
    result.metrics.find((m) => m.key === key)!;

  it('should pace volumes on the budget spent and compare rates directly', () => {
    const result = comparePerformance({
      ...base,
      insights: {
        totals: {
          date_start: '2026-10-01',
          date_stop: '2026-10-05',
          spend: '40000',
          reach: '5000',
          impressions: '20000',
          inline_link_clicks: '100',
          actions: [
            { action_type: 'link_click', value: '100' },
            { action_type: 'omni_purchase', value: '4' },
          ],
          action_values: [{ action_type: 'omni_purchase', value: '120000' }],
        },
        daily: [
          {
            date_start: '2026-10-01',
            date_stop: '2026-10-01',
            spend: '8000',
            reach: '1200',
            impressions: '4000',
            inline_link_clicks: '20',
            actions: [{ action_type: 'omni_purchase', value: '1' }],
          },
        ],
      },
    });

    // 40 000 / 100 000 dépensés : avancement 40 % (et non 50 % du temps).
    expect(result.spendProgress).toBe(0.4);
    expect(result.timeProgress).toBe(0.5);
    expect(result.progress).toBe(0.4);
    expect(result.conversionAction).toBe('omni_purchase');

    // Portée : 10 000 × 0,4 = 4 000 attendus, 5 000 réels → en avance.
    expect(byKey(result, 'reach')).toMatchObject({
      expected: 4000,
      actual: 5000,
      performance: 1.25,
      status: 'ahead',
    });
    // Clics : 400 × 0,4 = 160 attendus, 100 réels → en retard.
    expect(byKey(result, 'clicks')).toMatchObject({
      expected: 160,
      actual: 100,
      status: 'behind',
    });
    // CPC : 40 000 / 100 = 400 FCFA pour 100 prévus → coût 4× trop élevé.
    expect(byKey(result, 'cpc')).toMatchObject({
      expected: 100,
      actual: 400,
      performance: 0.25,
      status: 'behind',
    });
    // CTR : 100 / 20 000 = 0,5 % pour 1 % prévu ; ROAS 120 000 / 40 000 = 3.
    expect(byKey(result, 'ctr')).toMatchObject({
      actual: 0.5,
      status: 'behind',
    });
    expect(byKey(result, 'roas')).toMatchObject({ actual: 3, status: 'ahead' });
    expect(result.daily).toEqual([
      {
        date: '2026-10-01',
        spend: 8000,
        reach: 1200,
        impressions: 4000,
        clicks: 20,
        conversions: 1,
      },
    ]);
  });

  it('should convert EUR spend and skip costs for a non-convertible currency', () => {
    const insights = {
      totals: {
        date_start: '2026-10-01',
        date_stop: '2026-10-05',
        spend: '100',
        reach: '1000',
        impressions: '1000',
        inline_link_clicks: '10',
      },
      daily: [],
    };

    const eur = comparePerformance({ ...base, currency: 'EUR', insights });
    expect(eur.spendXaf).toBe(65596);
    expect(byKey(eur, 'cpc').actual).toBeCloseTo(6559.57, 1);

    const usd = comparePerformance({ ...base, currency: 'USD', insights });
    expect(usd.spendXaf).toBeNull();
    expect(usd.spendProgress).toBeNull();
    // Avancement : repli sur le temps écoulé.
    expect(usd.progress).toBe(0.5);
    expect(byKey(usd, 'cpc')).toMatchObject({
      actual: null,
      status: 'unknown',
    });
    // Le CTR ne dépend pas de la devise.
    expect(byKey(usd, 'ctr').actual).toBe(1);
  });

  it('should report an early campaign with no delivery yet', () => {
    const result = comparePerformance({
      ...base,
      now: new Date('2026-10-01T12:00:00Z'),
      insights: { totals: null, daily: [] },
    });
    expect(result.tooEarly).toBe(true);
    expect(result.spend).toBe(0);
    expect(byKey(result, 'reach')).toMatchObject({
      actual: null,
      status: 'unknown',
    });
  });

  it('should report unknown statuses without a simulation', () => {
    const result = comparePerformance({
      ...base,
      simulation: null,
      insights: {
        totals: {
          date_start: '2026-10-01',
          date_stop: '2026-10-05',
          spend: '1000',
          reach: '10',
        },
        daily: [],
      },
    });
    expect(result.metrics.every((m) => m.status === 'unknown')).toBe(true);
    expect(byKey(result, 'reach').actual).toBe(10);
  });
});

describe('pickConversionAction', () => {
  const actions = [
    {
      action_type: 'onsite_conversion.messaging_conversation_started_7d',
      value: '9',
    },
    { action_type: 'lead', value: '3' },
  ];

  it('should prefer the action matching the objective', () => {
    expect(pickConversionAction(DigitalObjective.LEADS, actions)).toBe('lead');
    expect(pickConversionAction(DigitalObjective.ENGAGEMENT, actions)).toBe(
      'onsite_conversion.messaging_conversation_started_7d',
    );
    expect(pickConversionAction(DigitalObjective.SALES, [])).toBeNull();
  });
});
