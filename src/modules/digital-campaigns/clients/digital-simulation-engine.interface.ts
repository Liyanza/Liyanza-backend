import { BudgetAllocationType, DigitalObjective } from '@prisma/client';

export const DIGITAL_SIMULATION_ENGINE_TOKEN =
  'DIGITAL_SIMULATION_ENGINE_TOKEN';

/**
 * Métriques réelles connues pour un canal au moment de la simulation.
 * `null` lorsque le canal est sélectionné mais qu'aucun compte social n'y
 * est encore lié (ou pas encore synchronisé) — la simulation dégrade
 * proprement plutôt que d'échouer, voir `DigitalCampaignsService`.
 */
export interface DigitalChannelMetricsSnapshot {
  followerCount?: number;
  reach?: number;
  impressions?: number;
  engagementRate?: number;
  avgCpm?: number;
  avgCpc?: number;
}

export interface DigitalSimulationChannelInput {
  platform: 'FACEBOOK' | 'INSTAGRAM';
  metrics: DigitalChannelMetricsSnapshot | null;
  /**
   * Un compte actif est lié au canal. Avec `metrics: null`, ses statistiques
   * ne sont simplement pas encore synchronisées (message distinct).
   */
  accountLinked?: boolean;
}

export interface DigitalSimulationParameters {
  objective: DigitalObjective;
  budget: { amount: number; allocation: BudgetAllocationType };
  audience: {
    ageMin: number;
    ageMax: number;
    targetGender: string;
    locations: string[];
    interests: string[];
  };
  channels: DigitalSimulationChannelInput[];
}

/**
 * Un scénario comparé parmi ceux proposés par le moteur (A/B/C) — un seul
 * est `isRecommended`, c'est celui dont `channelBreakdown`/`weeklySeries`
 * détaillent le déroulé sur `DigitalSimulationResult`.
 */
export interface DigitalSimulationScenarioSnapshot {
  id: string;
  label: string;
  isRecommended: boolean;
  score: number; // 0-100
  predictedReach: number;
  predictedClicks: number;
  predictedConversions: number;
  predictedRoas: number;
}

/**
 * Détail du scénario recommandé pour un canal réellement sélectionné —
 * jamais WhatsApp/TikTok/YouTube (non intégrés, voir `SocialPlatform`).
 */
export interface DigitalSimulationChannelSnapshot {
  platform: 'FACEBOOK' | 'INSTAGRAM';
  budgetAmount: number;
  budgetPercent: number;
  predictedReach: number;
  predictedClicks: number;
  predictedConversions: number;
  predictedRoas: number;
}

/** Point hebdomadaire de la courbe d'évolution du scénario recommandé. */
export interface DigitalSimulationWeekSnapshot {
  weekIndex: number; // 1-based
  predictedReach: number;
  predictedClicks: number;
  predictedConversions: number;
  budgetSpent: number;
}

/**
 * Forme alignée sur le contrat du futur moteur réel (XGBoost, `Liyanza-ia`) —
 * voir `docs/architecture.md`, section « Contrat IA — Simulation digitale ».
 *
 * `avgCpc`/`costPerAcquisition`/`conversionRate`/`scenarios`/
 * `channelBreakdown`/`weeklySeries` : extension ajoutée pour l'écran de
 * résultats détaillé, PAS validée contre le vrai moteur — voir le
 * commentaire sur `DigitalSimulation.scenarios` (prisma/schema.prisma) et
 * `docs/architecture.md` §6. Contrairement au reste de cette interface, un
 * branchement ultérieur sur Liyanza-ia devra probablement ajuster cette
 * partie.
 */
export interface DigitalSimulationResult {
  predictedReach: number;
  predictedEngagementRate: number;
  predictedCtr: number;
  predictedRoas: number;
  narrativeSummary: string;
  warnings: string[];
  avgCpc: number;
  costPerAcquisition: number;
  conversionRate: number;
  scenarios: DigitalSimulationScenarioSnapshot[];
  channelBreakdown: DigitalSimulationChannelSnapshot[];
  weeklySeries: DigitalSimulationWeekSnapshot[];
}

export interface DigitalSimulationEngineInterface {
  simulate(
    params: DigitalSimulationParameters,
  ): Promise<DigitalSimulationResult>;
}
