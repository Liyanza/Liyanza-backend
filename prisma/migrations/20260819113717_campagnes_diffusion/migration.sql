-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "plannedBudget" DECIMAL(12,2) NOT NULL,
    "actualBudget" DECIMAL(12,2) NOT NULL,
    "status" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "launchedById" TEXT NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdvertisingChannel" (
    "id" TEXT NOT NULL,
    "radio" BOOLEAN NOT NULL,
    "poster" BOOLEAN NOT NULL,
    "flyer" BOOLEAN NOT NULL,
    "campaignId" TEXT NOT NULL,

    CONSTRAINT "AdvertisingChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Broadcast" (
    "id" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "duration" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "audioProof" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "campaignId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,

    CONSTRAINT "Broadcast_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Campaign_launchedById_idx" ON "Campaign"("launchedById");

-- CreateIndex
CREATE INDEX "AdvertisingChannel_campaignId_idx" ON "AdvertisingChannel"("campaignId");

-- CreateIndex
CREATE INDEX "Broadcast_campaignId_idx" ON "Broadcast"("campaignId");

-- CreateIndex
CREATE INDEX "Broadcast_channelId_idx" ON "Broadcast"("channelId");

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_launchedById_fkey" FOREIGN KEY ("launchedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvertisingChannel" ADD CONSTRAINT "AdvertisingChannel_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Broadcast" ADD CONSTRAINT "Broadcast_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Broadcast" ADD CONSTRAINT "Broadcast_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "AdvertisingChannel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
