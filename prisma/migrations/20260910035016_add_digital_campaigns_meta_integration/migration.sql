-- CreateEnum
CREATE TYPE "CampaignType" AS ENUM ('DIGITAL', 'RADIO', 'POSTER');

-- CreateEnum
CREATE TYPE "DigitalObjective" AS ENUM ('AWARENESS', 'ENGAGEMENT', 'CONVERSION');

-- CreateEnum
CREATE TYPE "BudgetAllocationType" AS ENUM ('TOTAL', 'DAILY');

-- CreateEnum
CREATE TYPE "SocialPlatform" AS ENUM ('FACEBOOK', 'INSTAGRAM');

-- CreateEnum
CREATE TYPE "SocialAccountStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "MetricPeriod" AS ENUM ('DAY_7', 'DAY_28', 'LIFETIME');

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "type" "CampaignType" NOT NULL DEFAULT 'RADIO';

-- CreateTable
CREATE TABLE "DigitalCampaignDetails" (
    "id" TEXT NOT NULL,
    "objective" "DigitalObjective" NOT NULL,
    "ageMin" INTEGER NOT NULL,
    "ageMax" INTEGER NOT NULL,
    "targetGender" TEXT NOT NULL,
    "targetLocations" TEXT[],
    "targetInterests" TEXT[],
    "budgetAllocation" "BudgetAllocationType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "campaignId" TEXT NOT NULL,

    CONSTRAINT "DigitalCampaignDetails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DigitalCampaignChannel" (
    "id" TEXT NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "digitalCampaignDetailsId" TEXT NOT NULL,
    "socialAccountId" TEXT,

    CONSTRAINT "DigitalCampaignChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialAccount" (
    "id" TEXT NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "externalAccountId" TEXT NOT NULL,
    "externalAccountName" TEXT,
    "accessTokenCiphertext" TEXT NOT NULL,
    "accessTokenIv" TEXT NOT NULL,
    "accessTokenTag" TEXT NOT NULL,
    "tokenExpiresAt" TIMESTAMP(3),
    "scopes" TEXT[],
    "status" "SocialAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "companyId" TEXT NOT NULL,
    "connectedById" TEXT NOT NULL,

    CONSTRAINT "SocialAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformMetric" (
    "id" TEXT NOT NULL,
    "followerCount" INTEGER,
    "impressions" INTEGER,
    "reach" INTEGER,
    "engagementRate" DOUBLE PRECISION,
    "avgCpm" DECIMAL(12,2),
    "avgCpc" DECIMAL(12,2),
    "period" "MetricPeriod" NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rawPayload" JSONB NOT NULL,
    "socialAccountId" TEXT NOT NULL,

    CONSTRAINT "PlatformMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DigitalSimulation" (
    "id" TEXT NOT NULL,
    "simulatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inputSnapshot" JSONB NOT NULL,
    "predictedReach" INTEGER,
    "predictedEngagementRate" DOUBLE PRECISION,
    "predictedCtr" DOUBLE PRECISION,
    "predictedRoas" DOUBLE PRECISION,
    "narrativeSummary" TEXT,
    "warnings" TEXT[],
    "campaignId" TEXT NOT NULL,

    CONSTRAINT "DigitalSimulation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DigitalCampaignDetails_campaignId_key" ON "DigitalCampaignDetails"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "DigitalCampaignChannel_digitalCampaignDetailsId_platform_key" ON "DigitalCampaignChannel"("digitalCampaignDetailsId", "platform");

-- CreateIndex
CREATE INDEX "SocialAccount_companyId_idx" ON "SocialAccount"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "SocialAccount_companyId_platform_externalAccountId_key" ON "SocialAccount"("companyId", "platform", "externalAccountId");

-- CreateIndex
CREATE INDEX "PlatformMetric_socialAccountId_idx" ON "PlatformMetric"("socialAccountId");

-- CreateIndex
CREATE INDEX "PlatformMetric_fetchedAt_idx" ON "PlatformMetric"("fetchedAt");

-- CreateIndex
CREATE INDEX "DigitalSimulation_campaignId_idx" ON "DigitalSimulation"("campaignId");

-- AddForeignKey
ALTER TABLE "DigitalCampaignDetails" ADD CONSTRAINT "DigitalCampaignDetails_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DigitalCampaignChannel" ADD CONSTRAINT "DigitalCampaignChannel_digitalCampaignDetailsId_fkey" FOREIGN KEY ("digitalCampaignDetailsId") REFERENCES "DigitalCampaignDetails"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DigitalCampaignChannel" ADD CONSTRAINT "DigitalCampaignChannel_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialAccount" ADD CONSTRAINT "SocialAccount_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialAccount" ADD CONSTRAINT "SocialAccount_connectedById_fkey" FOREIGN KEY ("connectedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformMetric" ADD CONSTRAINT "PlatformMetric_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DigitalSimulation" ADD CONSTRAINT "DigitalSimulation_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
