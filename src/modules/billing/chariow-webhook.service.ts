import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import {
  BillingPeriod,
  Prisma,
  SubscriptionStatus,
  type PlanTier,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ChariowConfig, type ChariowProduct } from './chariow.config';
import { verifyChariowSignature } from './chariow-signature.util';

/** Champs lus dans une Pulse Chariow — tout le reste est ignoré. */
interface ChariowPulse {
  event?: unknown;
  sale?: {
    id?: unknown;
    amount?: { formatted?: unknown } | null;
    custom_metadata?: Record<string, unknown> | null;
  } | null;
  license?: { key?: unknown } | null;
  product?: { id?: unknown } | null;
  customer?: { email?: unknown } | null;
}

export type PulseResult =
  { ok: true; test: true } | { ok: true; duplicate: true } | { ok: true };

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === 'P2002';

/**
 * `date` + `months` mois (UTC), ramené au dernier jour du mois si besoin :
 * un abonnement mensuel pris le 31 janvier finit le 28/29 février, pas le
 * 3 mars.
 */
export function addMonthsUtc(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

/**
 * Traitement des Pulses (webhooks) Chariow.
 *
 * Principe : on ne fait confiance qu'à une Pulse signée, on ne la traite
 * qu'une fois (`ChariowDelivery`), et le PRODUIT acheté décide de la
 * formule accordée. Une Pulse incohérente (produit inconnu, métadonnées
 * contradictoires, entreprise introuvable) n'accorde rien mais reçoit
 * quand même un 200 : un refus ferait réessayer Chariow, puis désactiver
 * la Pulse, sans rien corriger.
 */
@Injectable()
export class ChariowWebhookService {
  private readonly logger = new Logger(ChariowWebhookService.name);

  constructor(
    private prisma: PrismaService,
    private config: ChariowConfig,
  ) {}

  async handle(
    rawBody: Buffer | undefined,
    signature: string | undefined,
    deliveryId: string | undefined,
  ): Promise<PulseResult> {
    if (!verifyChariowSignature(rawBody, signature, this.config.pulseSecret)) {
      throw new UnauthorizedException('Invalid signature.');
    }

    // Pulse de test envoyée depuis le tableau de bord Chariow : sans
    // identifiant de livraison, aucun effet métier.
    if (!deliveryId) {
      return { ok: true, test: true };
    }

    let pulse: ChariowPulse;
    try {
      pulse = JSON.parse(rawBody!.toString('utf8')) as ChariowPulse;
    } catch {
      this.logger.warn(`Pulse ${deliveryId} ignored: body is not JSON.`);
      return { ok: true };
    }
    if (!pulse || typeof pulse !== 'object') {
      this.logger.warn(`Pulse ${deliveryId} ignored: unexpected payload.`);
      return { ok: true };
    }
    const event = str(pulse.event) ?? 'unknown';

    try {
      await this.prisma.chariowDelivery.create({
        data: { id: deliveryId.slice(0, 200), event: event.slice(0, 100) },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return { ok: true, duplicate: true };
      }
      throw error;
    }

    try {
      await this.process(event, pulse);
    } catch (error) {
      // Échec technique (base indisponible…) : on oublie la livraison pour
      // que la nouvelle tentative de Chariow soit bien traitée.
      await this.prisma.chariowDelivery
        .delete({ where: { id: deliveryId.slice(0, 200) } })
        .catch(() => undefined);
      throw error;
    }
    return { ok: true };
  }

  private async process(event: string, pulse: ChariowPulse): Promise<void> {
    switch (event) {
      case 'successful.sale':
        return this.grantSale(pulse);
      case 'license.issued':
      case 'license.activated':
        return this.attachLicense(pulse);
      case 'license.revoked':
        return this.revokeLicense(pulse);
      default:
        // license.expired, license.nearing_expiry, failed.sale,
        // abandoned.sale… : nos propres dates pilotent l'expiration, et un
        // renouvellement est une nouvelle vente qui s'empile.
        this.logger.log(`Chariow pulse "${event}" ignored.`);
    }
  }

  private async grantSale(pulse: ChariowPulse): Promise<void> {
    const saleId = str(pulse.sale?.id);
    const productId = str(pulse.product?.id);
    const product = this.config.productById(productId);
    if (!saleId || !product) {
      this.logger.warn(
        `Sale ${saleId ?? '?'} not granted: unknown product ${productId ?? '?'}.`,
      );
      return;
    }

    const metadata = pulse.sale?.custom_metadata ?? {};
    if (!this.metadataMatches(metadata, product)) {
      this.logger.warn(
        `Sale ${saleId} not granted: metadata plan/period disagree with product ${productId}.`,
      );
      return;
    }

    const companyId = str(metadata.company_id);
    const company = companyId
      ? await this.prisma.company.findUnique({
          where: { id: companyId },
          select: { id: true },
        })
      : null;
    if (!company) {
      this.logger.warn(
        `Sale ${saleId} not granted: company ${companyId ?? '(missing)'} not found.`,
      );
      return;
    }

    const existing = await this.prisma.subscription.findUnique({
      where: { chariowSaleId: saleId },
      select: { id: true },
    });
    if (existing) return;

    // Acheteur retenu seulement s'il appartient bien à l'entreprise.
    const userId = str(metadata.user_id);
    const purchaser = userId
      ? await this.prisma.user.findFirst({
          where: { id: userId, companyId: company.id },
          select: { id: true },
        })
      : null;

    const now = new Date();
    try {
      await this.prisma.$transaction(async (tx) => {
        // Renouvellement de la même formule : la nouvelle période commence
        // à la fin de la précédente, pour ne perdre aucun jour payé.
        const latest = await tx.subscription.aggregate({
          where: {
            companyId: company.id,
            plan: product.plan,
            status: SubscriptionStatus.ACTIVE,
          },
          _max: { expiresAt: true },
        });
        const latestEnd = latest._max.expiresAt;
        const startsAt = latestEnd && latestEnd > now ? latestEnd : now;
        const months = product.period === BillingPeriod.YEARLY ? 12 : 1;

        await tx.subscription.create({
          data: {
            companyId: company.id,
            plan: product.plan,
            period: product.period,
            status: SubscriptionStatus.ACTIVE,
            startsAt,
            expiresAt: addMonthsUtc(startsAt, months),
            chariowSaleId: saleId,
            chariowProductId: productId!,
            customerEmail: str(pulse.customer?.email)?.toLowerCase() ?? null,
            purchasedById: purchaser?.id ?? null,
            amount: str(pulse.sale?.amount?.formatted) ?? null,
          },
        });
      });
    } catch (error) {
      // Même vente reçue deux fois en parallèle (livraisons distinctes).
      if (isUniqueViolation(error)) return;
      throw error;
    }
    this.logger.log(
      `Sale ${saleId}: ${product.plan} ${product.period} granted to company ${company.id}.`,
    );
  }

  /**
   * Les métadonnées viennent du checkout que NOUS avons créé ; si elles
   * contredisent le produit réellement payé, on n'accorde rien. Absentes
   * (vente créée hors de l'app), le produit fait foi.
   */
  private metadataMatches(
    metadata: Record<string, unknown>,
    product: ChariowProduct,
  ): boolean {
    const plan = str(metadata.plan) as PlanTier | undefined;
    const period = str(metadata.period) as BillingPeriod | undefined;
    return (
      (!plan || plan === product.plan) && (!period || period === product.period)
    );
  }

  private async attachLicense(pulse: ChariowPulse): Promise<void> {
    const key = str(pulse.license?.key);
    const productId = str(pulse.product?.id);
    const email = str(pulse.customer?.email)?.toLowerCase();
    if (!key || !productId || !email) {
      this.logger.warn('License pulse ignored: key, product or email missing.');
      return;
    }

    const alreadyAttached = await this.prisma.subscription.findUnique({
      where: { licenseKey: key },
      select: { id: true },
    });
    if (alreadyAttached) return;

    const target = await this.prisma.subscription.findFirst({
      where: {
        status: SubscriptionStatus.ACTIVE,
        chariowProductId: productId,
        customerEmail: email,
        licenseKey: null,
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (!target) {
      this.logger.warn(
        `License for product ${productId} not attached: no matching subscription.`,
      );
      return;
    }
    try {
      await this.prisma.subscription.update({
        where: { id: target.id },
        data: { licenseKey: key },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }

  private async revokeLicense(pulse: ChariowPulse): Promise<void> {
    const key = str(pulse.license?.key);
    const productId = str(pulse.product?.id);
    const email = str(pulse.customer?.email)?.toLowerCase();

    let target = key
      ? await this.prisma.subscription.findUnique({
          where: { licenseKey: key },
          select: { id: true },
        })
      : null;
    // Licence jamais rattachée (Pulse `license.issued` perdue) : repli sur
    // le dernier achat actif du même produit par le même client.
    if (!target && productId && email) {
      target = await this.prisma.subscription.findFirst({
        where: {
          status: SubscriptionStatus.ACTIVE,
          chariowProductId: productId,
          customerEmail: email,
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
    }
    if (!target) {
      this.logger.warn('License revocation ignored: no matching subscription.');
      return;
    }
    await this.prisma.subscription.update({
      where: { id: target.id },
      data: { status: SubscriptionStatus.REVOKED },
    });
    this.logger.log(`Subscription ${target.id} revoked by Chariow.`);
  }
}
