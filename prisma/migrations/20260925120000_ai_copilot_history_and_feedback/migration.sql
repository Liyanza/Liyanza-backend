-- CreateEnum
CREATE TYPE "AiMessageFeedback" AS ENUM ('UP', 'DOWN');

-- AlterTable
ALTER TABLE "AiConversation" ADD COLUMN     "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "AiMessage" ADD COLUMN     "feedback" "AiMessageFeedback";

-- CreateIndex
CREATE INDEX "AiConversation_createdById_lastMessageAt_idx" ON "AiConversation"("createdById", "lastMessageAt");


-- Backfill : les conversations existantes prennent la date de leur dernier
-- message (ou leur date de création si elles n'en ont aucun), pour que
-- l'historique du Copilot soit trié correctement dès le déploiement.
UPDATE "AiConversation" c
SET "lastMessageAt" = COALESCE(
  (SELECT MAX(m."sentAt") FROM "AiMessage" m WHERE m."conversationId" = c."id"),
  c."startedAt"
);
