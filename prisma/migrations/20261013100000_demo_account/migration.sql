-- Démo publique en lecture seule : l'entreprise fictive est repérée par ce
-- drapeau (ses utilisateurs ne peuvent rien modifier, ses données sont
-- recréées chaque nuit). Toutes les entreprises existantes restent réelles.
ALTER TABLE "Company" ADD COLUMN "isDemo" BOOLEAN NOT NULL DEFAULT false;
