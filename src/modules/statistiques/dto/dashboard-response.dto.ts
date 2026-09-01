import { CampaignStatus } from '@prisma/client';

export class DashboardCampaignSummary {
  id!: string;
  name!: string;
  status!: CampaignStatus;
  plannedBudget!: number;
  actualBudget!: number;
  broadcastCount!: number;
  broadcastedCount!: number;
  installationCount!: number;
  installedCount!: number;
}

export class DashboardResponseDto {
  companyId!: string;
  totalCampaigns!: number;
  campaignsByStatus!: Record<CampaignStatus, number>;
  totalPlannedBudget!: number;
  totalActualBudget!: number;
  budgetDeviation!: number;
  complianceRate!: number;
  installationRate!: number;
  unreadNotifications!: number;
  campaignsSummary!: DashboardCampaignSummary[];
}
