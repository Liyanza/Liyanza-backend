import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CampaignStatus, PlanTier, SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  PLAN_LIMITS,
  PlanLimitException,
  requiredPlanFor,
  type PlanLimits,
  type PlanName,
  type PlanSource,
} from './plan-limits';
import { demoCopilotDailyMessages } from '../demo/demo.constants';

export interface EffectivePlan {
  plan: PlanName;
  source: PlanSource;
  /** Fin de la formule payante en cours (périodes empilées comprises). */
  expiresAt: Date | null;
  trialEndsAt: Date | null;
  limits: PlanLimits;
}

export interface PlanUsage {
  activeCampaigns: number;
  members: number;
  copilotMessagesToday: number;
}

/** Statuts qui libèrent une place de campagne active. */
const CLOSED_CAMPAIGN_STATUSES = [
  CampaignStatus.COMPLETED,
  CampaignStatus.CANCELLED,
];

/** Expéditeur des messages de l'utilisateur dans `AiMessage.sender`. */
const USER_SENDER = 'USER';

const startOfUtcDay = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/**
 * Formule effective d'une entreprise et contrôle de ses limites. Exporté
 * par `BillingModule` et injecté dans les modules métier (campagnes,
 * membres, Copilot, IA) ; ne dépend que de Prisma, pour qu'aucun import
 * circulaire ne soit possible.
 *
 * Toujours recalculée depuis la base (quelques requêtes indexées) plutôt
 * que mise en cache : un paiement doit débloquer l'entreprise dès le
 * webhook reçu, une révocation la rebloquer aussitôt.
 */
@Injectable()
export class PlanService {
  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {}

  /**
   * Plus haute formule parmi les abonnements ACTIVE en cours
   * (`startsAt <= now < expiresAt`) ; sinon PRO pendant l'essai ; sinon FREE.
   */
  async getEffectivePlan(
    companyId: string,
    now: Date = new Date(),
  ): Promise<EffectivePlan> {
    const [company, subscriptions] = await Promise.all([
      this.prisma.company.findUnique({
        where: { id: companyId },
        select: { trialEndsAt: true, isDemo: true },
      }),
      // Les abonnements futurs (renouvellements empilés) sont lus aussi :
      // ils prolongent la date de fin affichée de la formule en cours.
      this.prisma.subscription.findMany({
        where: {
          companyId,
          status: SubscriptionStatus.ACTIVE,
          expiresAt: { gt: now },
        },
        select: { plan: true, startsAt: true, expiresAt: true },
      }),
    ]);
    const trialEndsAt = company?.trialEndsAt ?? null;
    const plan = this.resolvePlan(subscriptions, trialEndsAt, now);
    // Démo publique : formule PRO (essai renouvelé à chaque remise à zéro)
    // pour montrer les fonctions avancées, mais Copilot plafonné pour toute
    // l'entreprise — tous les visiteurs partagent ce quota du LLM.
    if (company?.isDemo) {
      plan.limits = {
        ...plan.limits,
        copilotDailyMessages: demoCopilotDailyMessages(this.config),
      };
    }
    return plan;
  }

  private resolvePlan(
    subscriptions: { plan: PlanTier; startsAt: Date; expiresAt: Date }[],
    trialEndsAt: Date | null,
    now: Date,
  ): EffectivePlan {
    const current = subscriptions.filter((s) => s.startsAt <= now);
    if (current.length > 0) {
      const plan: PlanTier = current.some((s) => s.plan === PlanTier.BUSINESS)
        ? PlanTier.BUSINESS
        : PlanTier.PRO;
      const expiresAt = subscriptions
        .filter((s) => s.plan === plan)
        .reduce<Date | null>(
          (max, s) => (!max || s.expiresAt > max ? s.expiresAt : max),
          null,
        );
      return {
        plan,
        source: 'PAID',
        expiresAt,
        trialEndsAt,
        limits: PLAN_LIMITS[plan],
      };
    }

    if (trialEndsAt && trialEndsAt > now) {
      return {
        plan: 'PRO',
        source: 'TRIAL',
        expiresAt: null,
        trialEndsAt,
        limits: PLAN_LIMITS.PRO,
      };
    }

    return {
      plan: 'FREE',
      source: 'FREE',
      expiresAt: null,
      trialEndsAt,
      limits: PLAN_LIMITS.FREE,
    };
  }

  async getUsage(
    companyId: string,
    now: Date = new Date(),
  ): Promise<PlanUsage> {
    const [activeCampaigns, members, copilotMessagesToday] = await Promise.all([
      this.countActiveCampaigns(companyId),
      this.countMembers(companyId),
      this.countCopilotMessagesToday(companyId, now),
    ]);
    return { activeCampaigns, members, copilotMessagesToday };
  }

  /** Création d'une campagne (brouillon compris). */
  async assertCanCreateCampaign(companyId: string): Promise<void> {
    const { plan, limits } = await this.getEffectivePlan(companyId);
    const limit = limits.maxActiveCampaigns;
    if (limit === null) return;
    if ((await this.countActiveCampaigns(companyId)) >= limit) {
      throw new PlanLimitException(
        'campaigns',
        requiredPlanFor('campaigns', plan),
        limit,
      );
    }
  }

  /** Ajout d'un membre (création, invitation, acceptation d'invitation). */
  async assertCanAddMember(companyId: string): Promise<void> {
    const { plan, limits } = await this.getEffectivePlan(companyId);
    const limit = limits.maxMembers;
    if (limit === null) return;
    if ((await this.countMembers(companyId)) >= limit) {
      throw new PlanLimitException(
        'members',
        requiredPlanFor('members', plan),
        limit,
      );
    }
  }

  /** Envoi (ou régénération) d'un message au Copilot. */
  async assertCopilotQuota(companyId: string): Promise<void> {
    const { plan, limits } = await this.getEffectivePlan(companyId);
    const limit = limits.copilotDailyMessages;
    if (limit === null) return;
    if (
      (await this.countCopilotMessagesToday(companyId, new Date())) >= limit
    ) {
      throw new PlanLimitException(
        'copilot',
        requiredPlanFor('copilot', plan),
        limit,
      );
    }
  }

  /** Vrai si la formule inclut l'IA avancée (simulations, recommandations). */
  async hasAiAdvanced(companyId: string): Promise<boolean> {
    const { limits } = await this.getEffectivePlan(companyId);
    return limits.aiAdvanced;
  }

  async assertAiAdvanced(companyId: string): Promise<void> {
    const { plan, limits } = await this.getEffectivePlan(companyId);
    if (!limits.aiAdvanced) {
      throw new PlanLimitException(
        'aiAdvanced',
        requiredPlanFor('aiAdvanced', plan),
        null,
      );
    }
  }

  // Les campagnes n'ont pas de suppression logique : seuls les statuts
  // terminaux libèrent une place. Le périmètre entreprise passe par
  // l'auteur, comme partout ailleurs (`launchedBy.companyId`).
  private countActiveCampaigns(companyId: string): Promise<number> {
    return this.prisma.campaign.count({
      where: {
        launchedBy: { companyId },
        status: { notIn: CLOSED_CAMPAIGN_STATUSES },
      },
    });
  }

  private countMembers(companyId: string): Promise<number> {
    return this.prisma.user.count({
      where: { companyId, deactivatedAt: null },
    });
  }

  private countCopilotMessagesToday(
    companyId: string,
    now: Date,
  ): Promise<number> {
    return this.prisma.aiMessage.count({
      where: {
        sender: USER_SENDER,
        sentAt: { gte: startOfUtcDay(now) },
        conversation: { companyId },
      },
    });
  }
}
