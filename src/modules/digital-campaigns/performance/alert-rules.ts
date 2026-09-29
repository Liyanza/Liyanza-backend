import { CampaignAlertSeverity, CampaignAlertType } from '@prisma/client';
import type { MetaCampaignInsights } from '../../social-accounts/clients/meta-ads.client';
import type {
  MetricKey,
  PerformanceComparison,
} from './performance-comparison';

/**
 * Règles des alertes « intelligentes » d'une campagne Facebook Ads reliée.
 * Fonction pure (testée dans alert-rules.spec.ts) : à partir de la
 * comparaison prévu/réel et des résultats bruts, liste les problèmes
 * actuels et les chiffres qui les montrent.
 */

export interface DetectedAlert {
  type: CampaignAlertType;
  severity: CampaignAlertSeverity;
  /** Chiffres affichés dans le message (pourcentages entiers, montants FCFA…). */
  data: Record<string, number>;
}

/** Seuils : documentés ici plutôt qu'en variables d'environnement. */
export const ALERT_THRESHOLDS = {
  /** Part du budget dépensée en avance sur la part du temps écoulé. */
  pacingFastGap: 0.25,
  /** Part du budget en retard sur le temps, après 30 % de la durée. */
  pacingSlowGap: 0.3,
  pacingSlowAfter: 0.3,
  /** Coût par clic ≥ 1,5 × la prévision (performance ≤ 0,67). */
  cpcPerformance: 0.67,
  cpcMinClicks: 30,
  /** Taux de clic ≤ 60 % de la prévision. */
  ctrPerformance: 0.6,
  ctrMinImpressions: 3000,
  /** Lassitude : fréquence ≥ 3 et taux de clic en baisse de 30 %. */
  fatigueFrequency: 3,
  fatigueCtrDrop: 0.3,
  fatigueMinDayImpressions: 200,
  /** Aucune conversion alors qu'au moins 3 étaient attendues. */
  noConversionExpected: 3,
  noConversionProgress: 0.3,
} as const;

const pct = (n: number) => Math.round(n * 100);

function metric(comparison: PerformanceComparison, key: MetricKey) {
  return comparison.metrics.find((m) => m.key === key);
}

/** Taux de clic moyen (%) d'une série de jours. */
function ctrOf(days: MetaCampaignInsights['daily']) {
  const impressions = days.reduce((s, d) => s + Number(d.impressions ?? 0), 0);
  const clicks = days.reduce(
    (s, d) => s + Number(d.inline_link_clicks ?? 0),
    0,
  );
  return impressions > 0 ? (clicks / impressions) * 100 : null;
}

export function detectAlerts(
  comparison: PerformanceComparison,
  insights: MetaCampaignInsights,
): DetectedAlert[] {
  const t = ALERT_THRESHOLDS;
  const alerts: DetectedAlert[] = [];
  const { spendProgress: sp, timeProgress: tp } = comparison;

  // Budget dépensé trop vite : la campagne risque de s'arrêter avant la fin.
  if (sp !== null && tp < 0.9 && sp - tp >= t.pacingFastGap) {
    alerts.push({
      type: CampaignAlertType.BUDGET_PACING_FAST,
      severity:
        sp >= 0.95
          ? CampaignAlertSeverity.CRITICAL
          : CampaignAlertSeverity.WARNING,
      data: { spendPct: pct(sp), timePct: pct(tp) },
    });
  }

  // Sous-diffusion : publicité refusée, en pause, audience trop étroite…
  if (sp !== null && tp >= t.pacingSlowAfter && tp - sp >= t.pacingSlowGap) {
    alerts.push({
      type: CampaignAlertType.BUDGET_PACING_SLOW,
      severity: CampaignAlertSeverity.WARNING,
      data: { spendPct: pct(sp), timePct: pct(tp) },
    });
  }

  // Les écarts de performance ne sont significatifs qu'après un démarrage.
  if (comparison.tooEarly) return alerts;

  const cpc = metric(comparison, 'cpc');
  const clicks = metric(comparison, 'clicks')?.actual ?? 0;
  if (
    cpc?.performance != null &&
    cpc.actual != null &&
    cpc.predicted != null &&
    cpc.performance <= t.cpcPerformance &&
    clicks >= t.cpcMinClicks
  ) {
    alerts.push({
      type: CampaignAlertType.CPC_HIGH,
      severity:
        cpc.performance <= 0.5
          ? CampaignAlertSeverity.CRITICAL
          : CampaignAlertSeverity.WARNING,
      data: {
        actualCpc: Math.round(cpc.actual),
        predictedCpc: Math.round(cpc.predicted),
      },
    });
  }

  const ctr = metric(comparison, 'ctr');
  const impressions = Number(insights.totals?.impressions ?? 0);
  if (
    ctr?.performance != null &&
    ctr.actual != null &&
    ctr.predicted != null &&
    ctr.performance <= t.ctrPerformance &&
    impressions >= t.ctrMinImpressions
  ) {
    alerts.push({
      type: CampaignAlertType.CTR_LOW,
      severity: CampaignAlertSeverity.WARNING,
      data: { actualCtr: ctr.actual, predictedCtr: ctr.predicted },
    });
  }

  // Lassitude : les mêmes personnes voient la publicité de plus en plus
  // souvent et cliquent de moins en moins.
  const frequency = Number(insights.totals?.frequency ?? 0);
  const activeDays = insights.daily.filter(
    (d) => Number(d.impressions ?? 0) >= t.fatigueMinDayImpressions,
  );
  if (frequency >= t.fatigueFrequency && activeDays.length >= 6) {
    const first = ctrOf(activeDays.slice(0, 3));
    const last = ctrOf(activeDays.slice(-3));
    if (first && last !== null && last <= first * (1 - t.fatigueCtrDrop)) {
      alerts.push({
        type: CampaignAlertType.AUDIENCE_FATIGUE,
        severity: CampaignAlertSeverity.WARNING,
        data: {
          frequency: Math.round(frequency * 10) / 10,
          ctrDropPct: pct(1 - last / first),
        },
      });
    }
  }

  const conversions = metric(comparison, 'conversions');
  if (
    conversions?.actual === 0 &&
    conversions.expected != null &&
    conversions.expected >= t.noConversionExpected &&
    comparison.progress >= t.noConversionProgress
  ) {
    alerts.push({
      type: CampaignAlertType.NO_CONVERSIONS,
      severity: CampaignAlertSeverity.CRITICAL,
      data: { expected: Math.round(conversions.expected) },
    });
  }

  return alerts;
}
