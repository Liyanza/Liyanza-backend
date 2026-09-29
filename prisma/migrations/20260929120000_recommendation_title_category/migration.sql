-- Titre et catégorie des recommandations générées par l'IA.
ALTER TABLE "Recommendation" ADD COLUMN "title" TEXT,
ADD COLUMN "category" TEXT;
