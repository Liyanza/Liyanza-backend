import { DigitalObjective } from '@prisma/client';

/**
 * Bornes heuristiques par objectif — ORDRES DE GRANDEUR généraux issus de
 * benchmarks Meta Ads couramment cités sur des marchés émergents comparables
 * au Cameroun. PAS une calibration propre à Liyanza : aucune donnée de
 * campagne réelle n'existe encore pour entraîner ou valider ces valeurs
 * (voir docs/architecture.md §6.5). Servent de repli quand
 * `ChannelMetricsSnapshot` ne fournit pas la métrique réelle correspondante
 * (voir digital-simulation-engine.heuristic.ts — les métriques réelles
 * priment toujours). À réviser dès que des résultats de campagnes réelles
 * Liyanza sont collectés.
 */
export interface ObjectiveBenchmark {
  cpmFcfa: [number, number]; // coût pour 1000 impressions, FCFA
  ctrPercent: [number, number]; // % clics / impressions
  conversionRatePercent: [number, number]; // % conversions / clics
  engagementRatePercent: [number, number]; // % engagements / portée
  roasBase: [number, number]; // retour sur dépense publicitaire
}

export const DIGITAL_SIMULATION_BENCHMARKS: Record<
  DigitalObjective,
  ObjectiveBenchmark
> = {
  AWARENESS: {
    cpmFcfa: [1200, 2800],
    ctrPercent: [0.4, 0.9],
    conversionRatePercent: [0.5, 1.5],
    engagementRatePercent: [2.0, 5.0],
    roasBase: [0.8, 1.6],
  },
  ENGAGEMENT: {
    cpmFcfa: [1500, 3200],
    ctrPercent: [1.2, 2.4],
    conversionRatePercent: [1.0, 3.0],
    engagementRatePercent: [3.0, 7.0],
    roasBase: [1.0, 2.0],
  },
  TRAFFIC: {
    cpmFcfa: [1400, 3000],
    ctrPercent: [1.0, 2.0],
    conversionRatePercent: [1.0, 2.5],
    engagementRatePercent: [1.5, 3.5],
    roasBase: [1.2, 2.2],
  },
  LEADS: {
    cpmFcfa: [2200, 4500],
    ctrPercent: [0.8, 1.6],
    conversionRatePercent: [4.0, 9.0],
    engagementRatePercent: [1.5, 3.0],
    roasBase: [1.5, 3.0],
  },
  CONVERSION: {
    cpmFcfa: [2500, 5000],
    ctrPercent: [0.7, 1.4],
    conversionRatePercent: [2.0, 5.0],
    engagementRatePercent: [1.0, 2.5],
    roasBase: [1.8, 3.5],
  },
  SALES: {
    cpmFcfa: [2800, 5500],
    ctrPercent: [0.6, 1.3],
    conversionRatePercent: [2.5, 5.5],
    engagementRatePercent: [1.0, 2.5],
    roasBase: [2.0, 4.0],
  },
};

export function midpoint([low, high]: [number, number]): number {
  return (low + high) / 2;
}
