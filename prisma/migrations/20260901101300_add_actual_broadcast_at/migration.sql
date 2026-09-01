/*
  Warnings:

  - The `status` column on the `Broadcast` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- CreateEnum
CREATE TYPE "BroadcastStatus" AS ENUM ('PLANNED', 'BROADCASTED', 'MISSED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Broadcast" ADD COLUMN     "actualBroadcastAt" TIMESTAMP(3),
DROP COLUMN "status",
ADD COLUMN     "status" "BroadcastStatus" NOT NULL DEFAULT 'PLANNED';
