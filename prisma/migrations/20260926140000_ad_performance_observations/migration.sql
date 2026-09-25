-- Références de coûts locales : résultats réels des campagnes Facebook Ads reliées.
CREATE TABLE "AdPerformanceObservation" (
    "id" TEXT NOT NULL,
    "objective" "DigitalObjective" NOT NULL,
    "city" TEXT,
    "businessSector" TEXT,
    "spendXaf" DOUBLE PRECISION NOT NULL,
    "impressions" INTEGER NOT NULL,
    "reach" INTEGER NOT NULL,
    "clicks" INTEGER NOT NULL,
    "conversions" INTEGER NOT NULL,
    "collectedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "campaignId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,

    CONSTRAINT "AdPerformanceObservation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdPerformanceObservation_campaignId_key" ON "AdPerformanceObservation"("campaignId");
CREATE INDEX "AdPerformanceObservation_objective_city_idx" ON "AdPerformanceObservation"("objective", "city");
CREATE INDEX "AdPerformanceObservation_companyId_objective_idx" ON "AdPerformanceObservation"("companyId", "objective");

ALTER TABLE "AdPerformanceObservation" ADD CONSTRAINT "AdPerformanceObservation_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
