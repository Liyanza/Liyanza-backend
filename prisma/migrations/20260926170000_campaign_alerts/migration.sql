-- Alertes intelligentes sur les campagnes Facebook Ads reliées.
CREATE TYPE "CampaignAlertType" AS ENUM ('BUDGET_PACING_FAST', 'BUDGET_PACING_SLOW', 'CPC_HIGH', 'CTR_LOW', 'AUDIENCE_FATIGUE', 'NO_CONVERSIONS');

CREATE TYPE "CampaignAlertSeverity" AS ENUM ('WARNING', 'CRITICAL');

CREATE TABLE "CampaignAlert" (
    "id" TEXT NOT NULL,
    "type" "CampaignAlertType" NOT NULL,
    "severity" "CampaignAlertSeverity" NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "campaignId" TEXT NOT NULL,

    CONSTRAINT "CampaignAlert_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CampaignAlert_campaignId_resolvedAt_idx" ON "CampaignAlert"("campaignId", "resolvedAt");

ALTER TABLE "CampaignAlert" ADD CONSTRAINT "CampaignAlert_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
