-- Abonnements payants (PRO / BUSINESS) vendus via Chariow, et essai PRO de
-- 14 jours offert à chaque entreprise.
CREATE TYPE "PlanTier" AS ENUM ('PRO', 'BUSINESS');

CREATE TYPE "BillingPeriod" AS ENUM ('MONTHLY', 'YEARLY');

CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'REVOKED');

ALTER TABLE "Company" ADD COLUMN "trialEndsAt" TIMESTAMP(3);

-- Les entreprises existantes reçoivent elles aussi 14 jours d'essai PRO, à
-- compter de cette migration : personne ne perd brutalement une fonction
-- utilisée la veille.
UPDATE "Company" SET "trialEndsAt" = now() + interval '14 days';

CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "plan" "PlanTier" NOT NULL,
    "period" "BillingPeriod" NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "chariowSaleId" TEXT NOT NULL,
    "chariowProductId" TEXT NOT NULL,
    "licenseKey" TEXT,
    "customerEmail" TEXT,
    "amount" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "companyId" TEXT NOT NULL,
    "purchasedById" TEXT,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChariowDelivery" (
    "id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChariowDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Subscription_chariowSaleId_key" ON "Subscription"("chariowSaleId");

CREATE UNIQUE INDEX "Subscription_licenseKey_key" ON "Subscription"("licenseKey");

CREATE INDEX "Subscription_companyId_idx" ON "Subscription"("companyId");

CREATE INDEX "Subscription_chariowProductId_customerEmail_idx" ON "Subscription"("chariowProductId", "customerEmail");

ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_purchasedById_fkey" FOREIGN KEY ("purchasedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
