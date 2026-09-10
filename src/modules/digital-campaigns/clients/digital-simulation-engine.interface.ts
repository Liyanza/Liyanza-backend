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
 * Forme alignée sur le contrat du futur moteur réel (XGBoost, `Liyanza-ia`) —
 * voir `docs/architecture.md`, section « Contrat IA — Simulation digitale ».
 * Un branchement ultérieur sur le vrai moteur ne doit exiger aucune
 * migration Prisma : `DigitalSimulation` reflète déjà cette forme.
 */
export interface DigitalSimulationResult {
  predictedReach: number;
  predictedEngagementRate: number;
  predictedCtr: number;
  predictedRoas: number;
  narrativeSummary: string;
  warnings: string[];
}

export interface DigitalSimulationEngineInterface {
  simulate(
    params: DigitalSimulationParameters,
  ): Promise<DigitalSimulationResult>;
}
