import { ForbiddenException } from '@nestjs/common';

/** Formule effective d'une entreprise (FREE n'est jamais stocké en base). */
export type PlanName = 'FREE' | 'PRO' | 'BUSINESS';

/** Origine de la formule effective. */
export type PlanSource = 'PAID' | 'TRIAL' | 'FREE';

/** Durée de l'essai PRO offert à chaque nouvelle entreprise. */
export const TRIAL_DAYS = 14;

/** Limites d'une formule. `null` = illimité. */
export interface PlanLimits {
  /** Campagnes ni COMPLETED ni CANCELLED (brouillons compris). */
  maxActiveCampaigns: number | null;
  /** Utilisateurs de l'entreprise non désactivés. */
  maxMembers: number | null;
  /** Messages envoyés au Copilot par l'entreprise, par jour UTC. */
  copilotDailyMessages: number | null;
  /** Simulations et recommandations générées par l'IA. */
  aiAdvanced: boolean;
  /** Suivi avancé (indicateur exposé au web uniquement). */
  advancedMonitoring: boolean;
}

export const PLAN_LIMITS: Record<PlanName, PlanLimits> = {
  FREE: {
    maxActiveCampaigns: 1,
    maxMembers: 1,
    copilotDailyMessages: 5,
    aiAdvanced: false,
    advancedMonitoring: false,
  },
  PRO: {
    maxActiveCampaigns: null,
    maxMembers: 3,
    copilotDailyMessages: null,
    aiAdvanced: true,
    advancedMonitoring: true,
  },
  BUSINESS: {
    maxActiveCampaigns: null,
    maxMembers: null,
    copilotDailyMessages: null,
    aiAdvanced: true,
    advancedMonitoring: true,
  },
};

/** Ordre des formules : sert à choisir la plus haute et la formule requise. */
export const PLAN_RANK: Record<PlanName, number> = {
  FREE: 0,
  PRO: 1,
  BUSINESS: 2,
};

/** Fonction limitée, telle qu'exposée au web dans une erreur PLAN_LIMIT. */
export type PlanFeature = 'campaigns' | 'members' | 'copilot' | 'aiAdvanced';

const FEATURE_LIMIT_KEY: Record<
  PlanFeature,
  'maxActiveCampaigns' | 'maxMembers' | 'copilotDailyMessages' | 'aiAdvanced'
> = {
  campaigns: 'maxActiveCampaigns',
  members: 'maxMembers',
  copilot: 'copilotDailyMessages',
  aiAdvanced: 'aiAdvanced',
};

/** Vrai si `candidate` est strictement plus permissive que `current`. */
function isMorePermissive(
  candidate: number | boolean | null,
  current: number | boolean | null,
): boolean {
  if (typeof current === 'boolean') return candidate === true && !current;
  if (current === null) return false;
  return candidate === null || (candidate as number) > current;
}

/**
 * Première formule, au-dessus de `current`, qui lève la limite atteinte :
 * c'est elle que le web propose (« Passez à PRO »). BUSINESS par défaut.
 */
export function requiredPlanFor(
  feature: PlanFeature,
  current: PlanName,
): 'PRO' | 'BUSINESS' {
  const key = FEATURE_LIMIT_KEY[feature];
  const currentValue = PLAN_LIMITS[current][key];
  for (const plan of ['PRO', 'BUSINESS'] as const) {
    if (PLAN_RANK[plan] <= PLAN_RANK[current]) continue;
    if (isMorePermissive(PLAN_LIMITS[plan][key], currentValue)) return plan;
  }
  return 'BUSINESS';
}

/** Messages en français : le web les traduit de toute façon via `code`/`feature`. */
const FEATURE_MESSAGES: Record<PlanFeature, (limit: number | null) => string> =
  {
    campaigns: (limit) =>
      `Votre formule est limitée à ${limit} campagne(s) active(s). Passez à une formule supérieure pour en créer davantage.`,
    members: (limit) =>
      `Votre formule est limitée à ${limit} membre(s). Passez à une formule supérieure pour inviter d'autres collaborateurs.`,
    copilot: (limit) =>
      `Vous avez atteint la limite de ${limit} messages au Copilot aujourd'hui. Passez à une formule supérieure pour continuer.`,
    aiAdvanced: () =>
      "Les simulations et recommandations de l'IA sont réservées aux formules PRO et BUSINESS.",
  };

/**
 * 403 levée quand une limite de formule est atteinte. Le corps porte un
 * `code` stable que le web reconnaît pour afficher l'offre de mise à niveau
 * (relayé tel quel par `AllExceptionsFilter`).
 */
export class PlanLimitException extends ForbiddenException {
  constructor(
    public readonly feature: PlanFeature,
    public readonly requiredPlan: 'PRO' | 'BUSINESS',
    public readonly limit: number | null,
  ) {
    super({
      statusCode: 403,
      code: 'PLAN_LIMIT',
      feature,
      requiredPlan,
      limit,
      message: FEATURE_MESSAGES[feature](limit),
    });
  }
}
