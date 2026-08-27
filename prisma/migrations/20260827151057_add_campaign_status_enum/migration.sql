/*
  Warnings:

  - The `status` column on the `Campaign` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Campaign" DROP COLUMN "status",
ADD COLUMN     "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT';
