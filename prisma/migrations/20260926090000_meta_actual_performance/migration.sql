-- Prévu vs réel : token publicitaire (ads_read) et lien vers la campagne Meta.
ALTER TABLE "SocialAccount" ADD COLUMN "adsTokenCiphertext" TEXT,
ADD COLUMN "adsTokenIv" TEXT,
ADD COLUMN "adsTokenTag" TEXT,
ADD COLUMN "adsTokenExpiresAt" TIMESTAMP(3);

ALTER TABLE "DigitalCampaignDetails" ADD COLUMN "metaAdAccountId" TEXT,
ADD COLUMN "metaCampaignId" TEXT,
ADD COLUMN "metaCampaignName" TEXT,
ADD COLUMN "metaAdCurrency" TEXT,
ADD COLUMN "metaCampaignLinkedAt" TIMESTAMP(3);
