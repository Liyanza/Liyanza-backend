import { Injectable } from '@nestjs/common';
import {
  DigitalSimulationEngineInterface,
  DigitalSimulationParameters,
  DigitalSimulationResult,
} from './digital-simulation-engine.interface';

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

    return {
      predictedReach,
      predictedEngagementRate,
      predictedCtr,
      predictedRoas,
      narrativeSummary: `Simulation pour un objectif "${params.objective}" avec un budget ${params.budget.allocation === 'DAILY' ? 'quotidien' : 'total'} de ${params.budget.amount}. Portée estimée : ${predictedReach.toLocaleString('fr-FR')} personnes.`,
      warnings,
    };
  }
}
