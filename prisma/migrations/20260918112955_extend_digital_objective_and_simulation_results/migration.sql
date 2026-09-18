-- AlterEnum
ALTER TYPE "DigitalObjective" ADD VALUE 'LEADS';
ALTER TYPE "DigitalObjective" ADD VALUE 'SALES';
ALTER TYPE "DigitalObjective" ADD VALUE 'TRAFFIC';

-- AlterTable
ALTER TABLE "DigitalSimulation" ADD COLUMN     "avgCpc" DOUBLE PRECISION,
ADD COLUMN     "channelBreakdown" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "conversionRate" DOUBLE PRECISION,
ADD COLUMN     "costPerAcquisition" DOUBLE PRECISION,
ADD COLUMN     "scenarios" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "weeklySeries" JSONB NOT NULL DEFAULT '[]';
