import { Injectable } from '@nestjs/common';
import {
  DigitalSimulationChannelSnapshot,
  DigitalSimulationEngineInterface,
  DigitalSimulationParameters,
  DigitalSimulationResult,
  DigitalSimulationScenarioSnapshot,
  DigitalSimulationWeekSnapshot,
} from './digital-simulation-engine.interface';

// Nombre de points de la courbe hebdomadaire — fixe faute de durée de
// campagne dans `DigitalSimulationParameters` (voir le contrat, §6.2 de
// `docs/architecture.md` : non étendu pour rester minimal côté entrée).
const WEEKLY_SERIES_LENGTH = 5;

/**
 * Implémentation mockée du moteur de simulation digitale — voir
 * `.claude/skills/liyanza-ia-boundary/SKILL.md` : ce repo ne calcule jamais
 * lui-même une prédiction de performance, il prépare et transmet les
 * données réelles (métriques Meta) au contrat que le futur `Liyanza-ia`
 * devra implémenter à l'identique.
 */
@Injectable()
export class DigitalSimulationEngineMock implements DigitalSimulationEngineInterface {
  async simulate(
    params: DigitalSimulationParameters,
  ): Promise<DigitalSimulationResult> {
    await new Promise((resolve) => setTimeout(resolve, 500));

    const warnings: string[] = [];
    const channelsWithMetrics = params.channels.filter((c) => c.metrics);
    for (const channel of params.channels) {
      if (!channel.metrics) {
        warnings.push(
          `Aucune métrique réelle disponible pour ${channel.platform} — connectez le compte social correspondant pour une prévision plus précise.`,
        );
      }
    }

    const totalFollowers = channelsWithMetrics.reduce(
      (sum, c) => sum + (c.metrics?.followerCount ?? 0),
      0,
    );
    const baseReach =
      totalFollowers > 0 ? totalFollowers * 0.3 : params.budget.amount * 20;

    const predictedReach = Math.round(baseReach * (0.8 + Math.random() * 0.4));
    const predictedEngagementRate =
      Math.round((1 + Math.random() * 4) * 100) / 100;
    const predictedCtr = Math.round((0.5 + Math.random() * 2) * 100) / 100;
    const predictedRoas = Math.round((1 + Math.random() * 3) * 100) / 100;
    const predictedClicks = Math.round(predictedReach * (predictedCtr / 100));
    const predictedConversions = Math.round(
      predictedClicks * (0.05 + Math.random() * 0.15),
    );

    const avgCpc =
      predictedClicks > 0
        ? Math.round((params.budget.amount / predictedClicks) * 100) / 100
        : 0;
    const costPerAcquisition =
      predictedConversions > 0
        ? Math.round((params.budget.amount / predictedConversions) * 100) / 100
        : 0;
    const conversionRate =
      predictedClicks > 0
        ? Math.round((predictedConversions / predictedClicks) * 10000) / 100
        : 0;

    const scenarios = this.buildScenarios({
      predictedReach,
      predictedClicks,
      predictedConversions,
      predictedRoas,
    });
    const channelBreakdown = this.buildChannelBreakdown(
      params,
      channelsWithMetrics.length > 0 ? channelsWithMetrics : params.channels,
      { predictedReach, predictedClicks, predictedConversions, predictedRoas },
    );
    const weeklySeries = this.buildWeeklySeries(params, {
      predictedReach,
      predictedClicks,
      predictedConversions,
    });

    return {
      predictedReach,
      predictedEngagementRate,
      predictedCtr,
      predictedRoas,
      narrativeSummary: `Simulation pour un objectif "${params.objective}" avec un budget ${params.budget.allocation === 'DAILY' ? 'quotidien' : 'total'} de ${params.budget.amount}. Portée estimée : ${predictedReach.toLocaleString('fr-FR')} personnes.`,
      warnings,
      avgCpc,
      costPerAcquisition,
      conversionRate,
      scenarios,
      channelBreakdown,
      weeklySeries,
    };
  }

  private buildScenarios(recommended: {
    predictedReach: number;
    predictedClicks: number;
    predictedConversions: number;
    predictedRoas: number;
  }): DigitalSimulationScenarioSnapshot[] {
    const variants: {
      id: string;
      label: string;
      factor: number;
      score: number;
    }[] = [
      { id: 'A', label: 'Scénario recommandé', factor: 1, score: 92 },
      { id: 'B', label: 'Scénario alternatif B', factor: 0.85, score: 78 },
      { id: 'C', label: 'Scénario alternatif C', factor: 0.7, score: 64 },
    ];

    return variants.map((variant) => ({
      id: variant.id,
      label: variant.label,
      isRecommended: variant.id === 'A',
      score: variant.score,
      predictedReach: Math.round(recommended.predictedReach * variant.factor),
      predictedClicks: Math.round(recommended.predictedClicks * variant.factor),
      predictedConversions: Math.round(
        recommended.predictedConversions * variant.factor,
      ),
      predictedRoas:
        Math.round(recommended.predictedRoas * variant.factor * 100) / 100,
    }));
  }

  private buildChannelBreakdown(
    params: DigitalSimulationParameters,
    channels: DigitalSimulationParameters['channels'],
    recommended: {
      predictedReach: number;
      predictedClicks: number;
      predictedConversions: number;
      predictedRoas: number;
    },
  ): DigitalSimulationChannelSnapshot[] {
    if (channels.length === 0) return [];

    // Répartition proportionnelle à l'audience connue (followerCount) quand
    // disponible pour chaque canal, sinon partage égal — faute de
    // répartition par canal dans `DigitalSimulationParameters.budget`
    // (un seul montant global, voir le contrat d'entrée).
    const weights = channels.map((c) => c.metrics?.followerCount ?? 1);
    const totalWeight =
      weights.reduce((sum, w) => sum + w, 0) || channels.length;

    return channels.map((channel, index) => {
      const share = weights[index] / totalWeight;
      return {
        platform: channel.platform,
        budgetAmount: Math.round(params.budget.amount * share * 100) / 100,
        budgetPercent: Math.round(share * 10000) / 100,
        predictedReach: Math.round(recommended.predictedReach * share),
        predictedClicks: Math.round(recommended.predictedClicks * share),
        predictedConversions: Math.round(
          recommended.predictedConversions * share,
        ),
        predictedRoas: recommended.predictedRoas,
      };
    });
  }

  private buildWeeklySeries(
    params: DigitalSimulationParameters,
    recommended: {
      predictedReach: number;
      predictedClicks: number;
      predictedConversions: number;
    },
  ): DigitalSimulationWeekSnapshot[] {
    // Courbe de montée en charge typique d'une campagne digitale (démarrage
    // progressif, pic en milieu de période) plutôt qu'une simple ligne
    // droite — cohérent avec `Cadence adaptative activée` affiché côté UI.
    const rampWeights = [0.12, 0.19, 0.24, 0.24, 0.21].slice(
      0,
      WEEKLY_SERIES_LENGTH,
    );
    const totalWeight = rampWeights.reduce((sum, w) => sum + w, 0);

    return rampWeights.map((weight, index) => {
      const share = weight / totalWeight;
      return {
        weekIndex: index + 1,
        predictedReach: Math.round(recommended.predictedReach * share),
        predictedClicks: Math.round(recommended.predictedClicks * share),
        predictedConversions: Math.round(
          recommended.predictedConversions * share,
        ),
        budgetSpent: Math.round(params.budget.amount * share * 100) / 100,
      };
    });
  }
}
