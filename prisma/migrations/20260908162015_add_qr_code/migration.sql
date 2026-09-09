-- CreateEnum
CREATE TYPE "QrCodeTargetType" AS ENUM ('WHATSAPP', 'FORM', 'PRODUCT_PAGE', 'PROMO');

-- CreateTable
CREATE TABLE "QrCode" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "targetType" "QrCodeTargetType" NOT NULL,
    "targetUrl" TEXT NOT NULL,
    "zone" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "installationId" TEXT,
    "campaignId" TEXT NOT NULL,

    CONSTRAINT "QrCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QrCodeScan" (
    "id" TEXT NOT NULL,
    "scannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "qrCodeId" TEXT NOT NULL,

    CONSTRAINT "QrCodeScan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "QrCode_code_key" ON "QrCode"("code");

-- CreateIndex
CREATE INDEX "QrCode_campaignId_idx" ON "QrCode"("campaignId");

-- CreateIndex
CREATE INDEX "QrCode_zone_idx" ON "QrCode"("zone");

-- CreateIndex
CREATE INDEX "QrCodeScan_qrCodeId_idx" ON "QrCodeScan"("qrCodeId");

-- CreateIndex
CREATE INDEX "QrCodeScan_scannedAt_idx" ON "QrCodeScan"("scannedAt");

-- AddForeignKey
ALTER TABLE "QrCode" ADD CONSTRAINT "QrCode_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "Installation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QrCode" ADD CONSTRAINT "QrCode_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QrCodeScan" ADD CONSTRAINT "QrCodeScan_qrCodeId_fkey" FOREIGN KEY ("qrCodeId") REFERENCES "QrCode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
