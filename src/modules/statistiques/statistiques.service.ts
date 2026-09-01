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
import { CampaignStatus, BroadcastStatus } from '@prisma/client';
import { Parser } from 'json2csv';
import PdfPrinter from 'pdfmake';
import type { TDocumentDefinitions } from 'pdfmake/interfaces';

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
    const where: any = { campaignId };
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

    // Fetch all campaigns of the company with their broadcasts and installations
    const campaigns = await this.prisma.campaign.findMany({
      where: {
        launchedBy: { companyId },
      },
      include: {
        broadcasts: true,
        installations: true,
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
        include: {
          broadcasts: true,
          installations: { include: { proof: true } },
          launchedBy: true,
        },
      });
      if (!campaign) {
        throw new NotFoundException('Campaign not found.');
      }
      assertSameCompany(user, campaign.launchedBy.companyId, 'Campaign');
      campaigns = [campaign];
    } else {
      campaigns = await this.prisma.campaign.findMany({
        where: {
          launchedBy: { companyId: user.companyId },
        },
        include: {
          broadcasts: true,
          installations: { include: { proof: true } },
          launchedBy: true,
        },
      });
    }

    // Transform into report rows
    const rows = campaigns.map((c) => ({
      'Campaign ID': c.id,
      'Campaign Name': c.name,
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
                `${(r['Broadcasted'] / (r['Total Broadcasts'] || 1)) * 100}%`,
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
