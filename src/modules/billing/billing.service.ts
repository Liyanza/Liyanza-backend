import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { ChariowClient } from './chariow.client';
import { ChariowConfig } from './chariow.config';
import { CreateCheckoutDto } from './dto/create-checkout.dto';
import { PlanService } from './plan.service';
import { PLAN_LIMITS } from './plan-limits';

/** Longueur maximale des noms acceptée par Chariow. */
const CHARIOW_NAME_MAX_LENGTH = 50;

/** Achats listés dans l'historique de la page « Abonnement ». */
const HISTORY_SIZE = 20;

const DEFAULT_COUNTRY_CODE = 'CM';

@Injectable()
export class BillingService {
  constructor(
    private prisma: PrismaService,
    private plans: PlanService,
    private chariow: ChariowClient,
    private config: ChariowConfig,
  ) {}

  /**
   * Ouvre une session de paiement Chariow pour l'entreprise de l'ADMIN.
   * Rien n'est accordé ici : seule la Pulse `successful.sale` (signée)
   * crée l'abonnement. Les métadonnées permettent de la rattacher à
   * l'entreprise.
   */
  async createCheckout(
    dto: CreateCheckoutDto,
    user: AuthenticatedUser,
    customerIp: string | undefined,
  ) {
    if (!user.companyId) {
      throw new ForbiddenException(
        'You must belong to a company to subscribe.',
      );
    }
    const productId = this.config.productFor(dto.plan, dto.period);
    if (!this.config.enabled || !productId) {
      throw new ServiceUnavailableException(
        "Le paiement en ligne n'est pas configuré sur ce serveur.",
      );
    }

    const buyer = await this.prisma.user.findUnique({
      where: { id: user.userId },
      select: { email: true, firstName: true, lastName: true },
    });
    if (!buyer) {
      throw new NotFoundException('User not found.');
    }
    const firstName = buyer.firstName.trim().slice(0, CHARIOW_NAME_MAX_LENGTH);
    const lastName =
      buyer.lastName.trim().slice(0, CHARIOW_NAME_MAX_LENGTH) || firstName;

    const result = await this.chariow.createCheckout({
      product_id: productId,
      email: buyer.email,
      first_name: firstName,
      last_name: lastName,
      phone: {
        number: dto.phone.number,
        country_code: dto.phone.countryCode ?? DEFAULT_COUNTRY_CODE,
      },
      ...(dto.discountCode && { discount_code: dto.discountCode }),
      ...(this.config.returnUrl && { redirect_url: this.config.returnUrl }),
      ...(customerIp && { customer_ip: customerIp }),
      custom_metadata: {
        company_id: user.companyId,
        user_id: user.userId,
        plan: dto.plan,
        period: dto.period,
      },
    });

    return result.step === 'payment'
      ? { checkoutUrl: result.checkoutUrl }
      : { checkoutUrl: null, step: result.step };
  }

  /**
   * Formule effective, limites, consommation et historique des achats.
   * Un utilisateur sans entreprise (onboarding) reçoit la réponse FREE, sans
   * consommation ni historique, plutôt qu'une erreur.
   */
  async getSubscription(user: AuthenticatedUser) {
    const billingEnabled = this.config.enabled;
    if (!user.companyId) {
      return {
        plan: 'FREE' as const,
        source: 'FREE' as const,
        expiresAt: null,
        trialEndsAt: null,
        limits: PLAN_LIMITS.FREE,
        usage: { activeCampaigns: 0, members: 0, copilotMessagesToday: 0 },
        billingEnabled,
        history: [],
      };
    }

    const now = new Date();
    const [effective, usage, history] = await Promise.all([
      this.plans.getEffectivePlan(user.companyId, now),
      this.plans.getUsage(user.companyId, now),
      this.prisma.subscription.findMany({
        where: { companyId: user.companyId },
        orderBy: { createdAt: 'desc' },
        take: HISTORY_SIZE,
        select: {
          id: true,
          plan: true,
          period: true,
          status: true,
          startsAt: true,
          expiresAt: true,
          amount: true,
          createdAt: true,
        },
      }),
    ]);

    return {
      plan: effective.plan,
      source: effective.source,
      expiresAt: effective.expiresAt?.toISOString() ?? null,
      trialEndsAt: effective.trialEndsAt?.toISOString() ?? null,
      limits: effective.limits,
      usage,
      billingEnabled,
      history: history.map((s) => ({
        ...s,
        startsAt: s.startsAt.toISOString(),
        expiresAt: s.expiresAt.toISOString(),
        createdAt: s.createdAt.toISOString(),
      })),
    };
  }
}
