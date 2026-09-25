import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import {
  DigitalChannelMetricsSnapshot,
  DigitalSimulationChannelSnapshot,
  DigitalSimulationEngineInterface,
  DigitalSimulationParameters,
  DigitalSimulationResult,
  DigitalSimulationScenarioSnapshot,
  DigitalSimulationWeekSnapshot,
} from './digital-simulation-engine.interface';
import {
  DIGITAL_SIMULATION_BENCHMARKS,
  midpoint,
} from './digital-simulation-engine.benchmarks';

const PLATFORM_LABEL: Record<'FACEBOOK' | 'INSTAGRAM', string> = {
  FACEBOOK: 'Facebook',
  INSTAGRAM: 'Instagram',
};

// Fréquence moyenne (impressions vues par personne unique) sur une campagne
// de plusieurs semaines — ordre de grandeur généralement observé sur Meta
// Ads, pas une mesure Liyanza.
const AVERAGE_FREQUENCY = 1.8;

// Portée organique additionnelle apportée par une audience déjà acquise
// (abonnés existants), en plus de la portée payante.
const ORGANIC_BOOST_RATIO = 0.15;

// Chevauchement d'audience Facebook/Instagram : une personne touchée sur les
// deux plateformes ne doit pas être comptée deux fois dans la portée totale.
// 0.85 = hypothèse raisonnable faute de donnée de chevauchement réelle.
const OVERLAP_DISCOUNT_MULTI_CHANNEL = 0.85;

// Montée en charge hebdomadaire (démarrage progressif, pic en milieu de
// période) — 5 points fixes faute de durée de campagne en entrée (§6.2).
const WEEKLY_RAMP = [0.12, 0.19, 0.24, 0.24, 0.21];

interface ChannelEstimate {
  platform: 'FACEBOOK' | 'INSTAGRAM';
  reach: number;
  clicks: number;
  conversions: number;
  ctr: number;
  engagementRate: number;
  roas: number;
  budgetAmount: number;
  budgetPercent: number;
}

/**
 * Implémentation RÉELLE (2026-09-19) et ACTIVE du moteur de simulation —
 * remplace `DigitalSimulationEngineMock`. 100% déterministe (formules +
 * bornes heuristiques), aucun appel réseau, aucun modèle entraîné : voir
 * `.claude/skills/liyanza-ia-boundary/SKILL.md` (« Cas particulier :
 * simulation de campagne digitale ») pour pourquoi ceci n'est PAS une
 * violation de la frontière IA du projet, et `docs/architecture.md` §6.4-6.5
 * pour l'historique de la tentative de service externe abandonnée.
 */
@Injectable()
export class DigitalSimulationEngineHeuristic implements DigitalSimulationEngineInterface {
  // Pas de `async`/`await` : ce moteur est 100% synchrone (aucun appel
  // réseau, aucune inférence) — voir docs/architecture.md §6.5. La
  // signature reste `Promise<...>` pour respecter DigitalSimulationEngine
  // Interface (implémentée aussi par un futur client HTTP, le jour où un
  // vrai besoin ML l'exigerait).
  simulate(
    params: DigitalSimulationParameters,
  ): Promise<DigitalSimulationResult> {
    if (params.channels.length === 0) {
      // Promise.reject, pas throw : cette méthode n'est pas `async` (aucun
      // await réel) — un throw synchrone romprait le contrat "cette
      // interface renvoie toujours une Promise, jamais une exception
      // synchrone" que respectait l'ancien mock (déclaré `async`).
      return Promise.reject(
        new Error('At least one channel is required to run a simulation.'),
      );
    }

    const seed = `${params.objective}:${params.budget.amount}:${params.budget.allocation}`;
    const warnings: string[] = [];

    const breadth = this.audienceBreadthScore(params.audience);

    // Répartition du budget par canal : proportionnelle à l'audience connue
    // (followerCount) quand disponible, sinon égale — le contrat d'entrée ne
    // porte qu'un budget global, pas de répartition par canal.
    const weights = params.channels.map(
      (channel) => channel.metrics?.followerCount || 1,
    );
    const totalWeight =
      weights.reduce((sum, weight) => sum + weight, 0) ||
      params.channels.length;

    const channelEstimates: ChannelEstimate[] = params.channels.map(
      (channel, index) => {
        if (!channel.metrics) {
          warnings.push(
            channel.accountLinked
              ? `Les statistiques du compte ${channel.platform} lié ne sont pas encore synchronisées — la prévision utilise les références de marché. Resynchronisez le compte depuis Mon entreprise puis relancez la simulation.`
              : `Aucune métrique réelle disponible pour ${channel.platform} — connectez le compte social correspondant pour une prévision plus précise.`,
          );
        }
        const share = weights[index] / totalWeight;
        const channelBudget = params.budget.amount * share;
        const estimate = this.estimateChannel(
          channel.platform,
          params.objective,
          channelBudget,
          channel.metrics,
          breadth,
          `${seed}:${channel.platform}`,
        );
        return {
          ...estimate,
          budgetAmount: Math.round(channelBudget * 100) / 100,
          budgetPercent: Math.round(share * 10000) / 100,
        };
      },
    );

    const overlap =
      channelEstimates.length > 1 ? OVERLAP_DISCOUNT_MULTI_CHANNEL : 1;
    const predictedReach = Math.round(
      channelEstimates.reduce((sum, c) => sum + c.reach, 0) * overlap,
    );
    const predictedClicks = Math.round(
      channelEstimates.reduce((sum, c) => sum + c.clicks, 0),
    );
    const predictedConversions = Math.round(
      channelEstimates.reduce((sum, c) => sum + c.conversions, 0),
    );
    const predictedEngagementRate =
      Math.round(
        (channelEstimates.reduce((sum, c) => sum + c.engagementRate, 0) /
          channelEstimates.length) *
          100,
      ) / 100;
    const predictedRoas =
      Math.round(
        (channelEstimates.reduce((sum, c) => sum + c.roas, 0) /
          channelEstimates.length) *
          100,
      ) / 100;
    const predictedCtr =
      predictedReach > 0
        ? Math.round((predictedClicks / predictedReach) * 10000) / 100
        : 0;

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

    const channelBreakdown: DigitalSimulationChannelSnapshot[] =
      channelEstimates.map((c) => ({
        platform: c.platform,
        budgetAmount: c.budgetAmount,
        budgetPercent: c.budgetPercent,
        predictedReach: c.reach,
        predictedClicks: c.clicks,
        predictedConversions: c.conversions,
        predictedRoas: c.roas,
      }));

    const scenarios = this.buildScenarios({
      predictedReach,
      predictedClicks,
      predictedConversions,
      predictedRoas,
    });
    const weeklySeries = this.buildWeeklySeries(params.budget.amount, {
      predictedReach,
      predictedClicks,
      predictedConversions,
    });

    const result = {
      predictedReach,
      predictedEngagementRate,
      predictedCtr,
      predictedRoas,
      warnings,
      avgCpc,
      costPerAcquisition,
      conversionRate,
      scenarios,
      channelBreakdown,
      weeklySeries,
    };

    return Promise.resolve({
      ...result,
      narrativeSummary: this.buildNarrativeSummary(
        params,
        result,
        channelBreakdown,
      ),
    });
  }

  /** ~1.0 pour un ciblage "moyen" ; > 1 pour une audience large (plafond de
   * portée plus haut), < 1 pour un ciblage étroit. Ne modélise PAS d'effet
   * sur le CTR/la pertinence (aucune donnée réelle ne permet aujourd'hui de
   * calibrer ce lien pour Liyanza). */
  private audienceBreadthScore(
    audience: DigitalSimulationParameters['audience'],
  ): number {
    const ageSpan = Math.max(1, audience.ageMax - audience.ageMin);
    const ageFactor = Math.min(1.3, 0.7 + ageSpan / 60);
    const genderFactor = audience.targetGender === 'ALL' ? 1.15 : 0.85;
    const locationFactor = Math.min(1.2, 0.8 + 0.1 * audience.locations.length);
    const interestFactor = audience.interests.length
      ? Math.min(1.1, 1.0 + 0.02 * audience.interests.length)
      : 0.95;
    return (ageFactor * genderFactor * locationFactor * interestFactor) / 1.1;
  }

  /** Variation légère mais REPRODUCTIBLE (même entrée -> même sortie),
   * dérivée d'un hash de `seed` plutôt que de `Math.random()` : relancer une
   * simulation avec des paramètres identiques doit renvoyer le même
   * résultat. */
  private deterministicJitter(seed: string, spread = 0.08): number {
    const digest = createHash('sha256').update(seed).digest('hex');
    const fraction = parseInt(digest.slice(0, 8), 16) / 0xffffffff; // 0..1
    return 1 + (fraction - 0.5) * 2 * spread;
  }

  private estimateChannel(
    platform: 'FACEBOOK' | 'INSTAGRAM',
    objective: DigitalSimulationParameters['objective'],
    budgetAmount: number,
    metrics: DigitalChannelMetricsSnapshot | null | undefined,
    breadth: number,
    seed: string,
  ): Omit<ChannelEstimate, 'budgetAmount' | 'budgetPercent'> {
    const bench = DIGITAL_SIMULATION_BENCHMARKS[objective];

    const cpm =
      metrics?.avgCpm ||
      midpoint(bench.cpmFcfa) * this.deterministicJitter(`${seed}:cpm`);
    const impressions = cpm > 0 ? (budgetAmount / cpm) * 1000 : 0;
    const reachFromBudget = impressions / AVERAGE_FREQUENCY;

    const followerCount = metrics?.followerCount ?? 0;
    const reach =
      (reachFromBudget + followerCount * ORGANIC_BOOST_RATIO) * breadth;

    let ctr: number;
    if (metrics?.avgCpc && metrics.avgCpc > 0) {
      // CPC = (CPM/1000) / CTR  =>  CTR = (CPM/1000) / CPC — dérivé de deux
      // métriques réelles plutôt qu'une borne générique.
      ctr = (cpm / 1000 / metrics.avgCpc) * 100;
    } else {
      ctr =
        midpoint(bench.ctrPercent) * this.deterministicJitter(`${seed}:ctr`);
    }
    const clicks = reach * (ctr / 100);

    const conversionRate =
      midpoint(bench.conversionRatePercent) *
      this.deterministicJitter(`${seed}:conv`);
    const conversions = clicks * (conversionRate / 100);

    const engagementRate =
      metrics?.engagementRate ??
      midpoint(bench.engagementRatePercent) *
        this.deterministicJitter(`${seed}:eng`);

    const roas =
      midpoint(bench.roasBase) * this.deterministicJitter(`${seed}:roas`);

    return {
      platform,
      reach: Math.round(reach),
      clicks: Math.round(clicks),
      conversions: Math.round(conversions),
      ctr: Math.round(ctr * 100) / 100,
      engagementRate: Math.round(engagementRate * 100) / 100,
      roas: Math.round(roas * 100) / 100,
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

  private buildWeeklySeries(
    budgetAmount: number,
    recommended: {
      predictedReach: number;
      predictedClicks: number;
      predictedConversions: number;
    },
  ): DigitalSimulationWeekSnapshot[] {
    const totalWeight = WEEKLY_RAMP.reduce((sum, w) => sum + w, 0);

    return WEEKLY_RAMP.map((weight, index) => {
      const share = weight / totalWeight;
      return {
        weekIndex: index + 1,
        predictedReach: Math.round(recommended.predictedReach * share),
        predictedClicks: Math.round(recommended.predictedClicks * share),
        predictedConversions: Math.round(
          recommended.predictedConversions * share,
        ),
        budgetSpent: Math.round(budgetAmount * share * 100) / 100,
      };
    });
  }

  /** Gabarit de texte conditionnel — PAS un appel LLM (voir docs/
   * architecture.md §6.4 : reformuler des chiffres déjà calculés ne
   * justifie pas une dépendance externe). */
  private buildNarrativeSummary(
    params: DigitalSimulationParameters,
    result: {
      predictedReach: number;
      predictedRoas: number;
      warnings: string[];
    },
    channelBreakdown: DigitalSimulationChannelSnapshot[],
  ): string {
    const period = params.budget.allocation === 'DAILY' ? 'quotidien' : 'total';
    const sentences: string[] = [
      `Simulation pour un objectif "${params.objective}" avec un budget ${period} de ${params.budget.amount.toLocaleString('fr-FR')} FCFA : portée estimée ${result.predictedReach.toLocaleString('fr-FR')} personnes, ${result.predictedRoas.toFixed(1)}x de retour sur dépense attendu.`,
    ];

    if (result.predictedRoas >= 2.5) {
      sentences.push(
        'Ce retour est nettement au-dessus de la moyenne pour cet objectif.',
      );
    } else if (result.predictedRoas < 1.2) {
      sentences.push(
        'Ce retour reste modeste — un objectif ou un ciblage différent pourrait mieux convertir ce budget.',
      );
    }

    if (result.warnings.length > 0) {
      sentences.push(
        'Connectez les comptes sociaux manquants pour affiner cette prévision.',
      );
    } else if (channelBreakdown.length > 1) {
      const best = [...channelBreakdown].sort(
        (a, b) => b.predictedRoas - a.predictedRoas,
      )[0];
      sentences.push(
        `${PLATFORM_LABEL[best.platform]} concentre le meilleur retour attendu — envisagez d'y prioriser le budget.`,
      );
    }

    return sentences.join(' ');
  }
}
