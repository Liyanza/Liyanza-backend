import { Injectable, Logger } from '@nestjs/common';
import { DigitalObjective } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { MetaInsightsRow } from '../../social-accounts/clients/meta-ads.client';
import type { LocalBenchmark } from '../clients/digital-simulation-engine.interface';
import { observedTotals } from './performance-comparison';

/** Campagnes minimum de l'entreprise elle-même pour calibrer ses simulations. */
const MIN_OWN_CAMPAIGNS = 2;
/** Entreprises distinctes minimum pour qu'un agrégat serve à d'autres (anonymat). */
const MIN_COMPANIES = 3;

/** « Douala », « douala » et « DOUALA » : même ville. */
export function normalizeCity(value: string | undefined | null): string | null {
  const city = value?.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
  return city || null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

interface ObservationRow {
  companyId: string;
  spendXaf: number;
  impressions: number;
  clicks: number;
  conversions: number;
}

/** Médianes des taux par campagne (robustes à une campagne atypique). */
export function aggregate(
  rows: ObservationRow[],
  scope: LocalBenchmark['scope'],
  city: string | null,
): LocalBenchmark {
  const round = (n: number | null, d: number) =>
    n === null ? null : Math.round(n * 10 ** d) / 10 ** d;
  return {
    scope,
    city,
    campaigns: rows.length,
    companies: new Set(rows.map((r) => r.companyId)).size,
    cpmFcfa: round(
      median(rows.map((r) => (r.spendXaf / r.impressions) * 1000)),
      0,
    ),
    ctrPercent: round(
      median(rows.map((r) => (r.clicks / r.impressions) * 100)),
      2,
    ),
    conversionRatePercent: round(
      median(
        rows
          .filter((r) => r.clicks > 0)
          .map((r) => (r.conversions / r.clicks) * 100),
      ),
      2,
    ),
  };
}

/**
 * Références de coûts locales : les résultats réels des campagnes Facebook
 * Ads reliées (« Prévu vs réel ») recalibrent le moteur de simulation. Les
 * observations sont enregistrées par CampaignPerformanceService, à chaque
 * lecture fraîche et chaque matin (refreshAllLinked).
 */
@Injectable()
export class LocalBenchmarksService {
  private readonly logger = new Logger(LocalBenchmarksService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Enregistre (ou met à jour) les totaux réels d'une campagne. */
  async record(input: {
    campaignId: string;
    companyId: string;
    objective: DigitalObjective;
    locations: string[];
    currency: string;
    totals: MetaInsightsRow | null;
  }): Promise<void> {
    const totals = observedTotals(
      input.objective,
      input.totals,
      input.currency,
    );
    if (!totals) return;
    const company = await this.prisma.company.findUnique({
      where: { id: input.companyId },
      select: { businessSector: true },
    });
    const data = {
      objective: input.objective,
      city: normalizeCity(input.locations[0]),
      businessSector: company?.businessSector ?? null,
      spendXaf: totals.spendXaf,
      impressions: Math.round(totals.impressions),
      reach: Math.round(totals.reach),
      clicks: Math.round(totals.clicks),
      conversions: Math.round(totals.conversions),
      companyId: input.companyId,
    };
    await this.prisma.adPerformanceObservation.upsert({
      where: { campaignId: input.campaignId },
      create: { ...data, campaignId: input.campaignId },
      update: data,
    });
  }

  /**
   * Référence la plus pertinente pour une simulation : l'historique de
   * l'entreprise, puis la même ville, puis tout le marché — un agrégat
   * d'autres entreprises n'est utilisé qu'à partir de 3 entreprises.
   */
  async getCalibration(
    companyId: string,
    objective: DigitalObjective,
    locations: string[],
  ): Promise<LocalBenchmark | null> {
    const rows = await this.prisma.adPerformanceObservation.findMany({
      where: { objective },
      select: {
        companyId: true,
        city: true,
        spendXaf: true,
        impressions: true,
        clicks: true,
        conversions: true,
      },
    });
    const own = rows.filter((r) => r.companyId === companyId);
    if (own.length >= MIN_OWN_CAMPAIGNS) return aggregate(own, 'company', null);

    const city = normalizeCity(locations[0]);
    const inCity = city ? rows.filter((r) => r.city === city) : [];
    if (new Set(inCity.map((r) => r.companyId)).size >= MIN_COMPANIES) {
      return aggregate(inCity, 'city', city);
    }
    if (new Set(rows.map((r) => r.companyId)).size >= MIN_COMPANIES) {
      return aggregate(rows, 'objective', null);
    }
    return null;
  }
}
