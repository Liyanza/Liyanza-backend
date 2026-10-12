import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BillingPeriod, PlanTier } from '@prisma/client';

export interface ChariowProduct {
  plan: PlanTier;
  period: BillingPeriod;
}

const PRODUCT_ENV: ReadonlyArray<
  [envName: string, plan: PlanTier, period: BillingPeriod]
> = [
  ['CHARIOW_PRODUCT_PRO_MONTHLY', PlanTier.PRO, BillingPeriod.MONTHLY],
  ['CHARIOW_PRODUCT_PRO_YEARLY', PlanTier.PRO, BillingPeriod.YEARLY],
  [
    'CHARIOW_PRODUCT_BUSINESS_MONTHLY',
    PlanTier.BUSINESS,
    BillingPeriod.MONTHLY,
  ],
  ['CHARIOW_PRODUCT_BUSINESS_YEARLY', PlanTier.BUSINESS, BillingPeriod.YEARLY],
];

/**
 * Configuration Chariow lue une fois au démarrage. Toutes les variables sont
 * facultatives : sans clé API ou sans les quatre produits, la vente est
 * simplement désactivée (`enabled = false`) et le serveur démarre quand même
 * (dev local, CI). Le produit Chariow est la SEULE source de vérité sur ce
 * qui a été acheté : les métadonnées d'une vente ne font que la confirmer.
 */
@Injectable()
export class ChariowConfig {
  readonly apiKey: string | undefined;
  readonly pulseSecret: string | undefined;
  readonly returnUrl: string | undefined;
  private readonly byProductId = new Map<string, ChariowProduct>();
  private readonly byPlan = new Map<string, string>();

  constructor(config: ConfigService) {
    this.apiKey = config.get<string>('CHARIOW_API_KEY') || undefined;
    this.pulseSecret = config.get<string>('CHARIOW_PULSE_SECRET') || undefined;
    this.returnUrl = config.get<string>('BILLING_RETURN_URL') || undefined;
    for (const [envName, plan, period] of PRODUCT_ENV) {
      const productId = config.get<string>(envName)?.trim();
      if (!productId) continue;
      this.byProductId.set(productId, { plan, period });
      this.byPlan.set(`${plan}:${period}`, productId);
    }
  }

  /** Vente possible : clé API et les quatre produits configurés. */
  get enabled(): boolean {
    return !!this.apiKey && this.byPlan.size === PRODUCT_ENV.length;
  }

  productFor(plan: PlanTier, period: BillingPeriod): string | undefined {
    return this.byPlan.get(`${plan}:${period}`);
  }

  productById(productId: string | undefined): ChariowProduct | undefined {
    return productId ? this.byProductId.get(productId) : undefined;
  }
}
