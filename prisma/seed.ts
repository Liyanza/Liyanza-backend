/**
 * Seed de développement — Liyanza backend (BACK-107 / suite de BACK-104, BACK-106).
 *
 * Objectif : fournir à toute l'équipe un jeu de données cohérent (entreprise,
 * utilisateurs, campagne, canaux) pour développer et tester localement sans
 * dépendre d'une saisie manuelle répétée.
 *
 * Portée volontairement minimale : 1 entreprise, 1 utilisateur par rôle clé
 * (ADMIN / MARKETING_MANAGER / PROVIDER), 1 campagne et 1 canal de diffusion
 * d'exemple, suffisants pour valider manuellement les parcours de la Phase 2
 * (cf. `docs/security.md` pour le détail des rôles).
 *
 * Idempotence : chaque écriture utilise `upsert` sur un identifiant fixe
 * (`seed-*`) plutôt que `create`, afin que la commande puisse être exécutée
 * plusieurs fois de suite sans dupliquer les données ni lever d'erreur de
 * contrainte unique.
 *
 * ⚠️ Garde de sécurité : ce script REFUSE de s'exécuter si
 * `NODE_ENV=production`, pour qu'aucune donnée de seed (y compris les
 * comptes de test ci-dessous) ne puisse fuiter vers un environnement réel,
 * même en cas d'erreur humaine (mauvais `.env`, mauvaise commande CI...).
 *
 * Utilisation :
 *   npx prisma migrate reset   → recrée le schéma, PUIS exécute ce seed
 *   npx prisma db seed         → exécute uniquement ce seed
 */

import 'dotenv/config';
import { PrismaClient, Role, CampaignStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

/**
 * Même coût de hachage que `AuthService.register` (BACK-105) afin que le
 * comportement des comptes de seed reste représentatif du comportement réel
 * de l'application (temps de vérification au login, etc.).
 */
const SALT_ROUNDS = 10;

/**
 * Mots de passe de développement.
 *
 * Volontairement complexes (majuscules, minuscules, chiffres, symboles,
 * ≥ 20 caractères, aucun mot du dictionnaire) même s'il ne s'agit que de
 * données de seed local : un mot de passe faible/devinable resterait un
 * risque si ce script était, par erreur humaine, exécuté sur un
 * environnement accessible autrement qu'en local — d'où également la garde
 * `NODE_ENV !== 'production'` ci-dessous, qui reste la protection
 * principale.
 */
const SEED_PASSWORDS = {
  admin: 'S3ed#Adm1n_Liyanza-2026!',
  marketingManager: 'S3ed#MktMgr_Liyanza-2026!',
  provider: 'S3ed#Presta_Liyanza-2026!',
} as const;

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      '[seed] Exécution refusée : NODE_ENV=production. ' +
        'Ce script ne doit jamais être lancé sur un environnement de production.',
    );
  }

  console.log(
    `[seed] Démarrage (NODE_ENV=${process.env.NODE_ENV ?? 'undefined'})…`,
  );

  // ---------------------------------------------------------------------
  // 1. Entreprise de test (racine multi-tenant)
  // ---------------------------------------------------------------------
  const company = await prisma.company.upsert({
    where: { id: 'seed-company-1' },
    update: {},
    create: {
      id: 'seed-company-1',
      name: 'Liyanza Demo SARL',
      businessSector: 'Agroalimentaire',
      address: 'Akwa, Douala, Cameroun',
    },
  });

  // ---------------------------------------------------------------------
  // 2. Un utilisateur par rôle clé (cf. BACK-106 / docs/security.md)
  // ---------------------------------------------------------------------
  const [adminPasswordHash, marketingPasswordHash, providerPasswordHash] =
    await Promise.all([
      bcrypt.hash(SEED_PASSWORDS.admin, SALT_ROUNDS),
      bcrypt.hash(SEED_PASSWORDS.marketingManager, SALT_ROUNDS),
      bcrypt.hash(SEED_PASSWORDS.provider, SALT_ROUNDS),
    ]);

  const admin = await prisma.user.upsert({
    where: { id: 'seed-user-admin' },
    update: {},
    create: {
      id: 'seed-user-admin',
      firstName: 'Admin',
      lastName: 'Seed',
      email: 'admin.seed@liyanza.local',
      password: adminPasswordHash,
      phone: '+237600000001',
      role: Role.ADMIN,
      companyId: company.id,
    },
  });

  const marketingManager = await prisma.user.upsert({
    where: { id: 'seed-user-marketing-manager' },
    update: {},
    create: {
      id: 'seed-user-marketing-manager',
      firstName: 'Marketing',
      lastName: 'Seed',
      email: 'marketing.seed@liyanza.local',
      password: marketingPasswordHash,
      phone: '+237600000002',
      role: Role.MARKETING_MANAGER,
      companyId: company.id,
    },
  });

  const provider = await prisma.user.upsert({
    where: { id: 'seed-user-provider' },
    update: {},
    create: {
      id: 'seed-user-provider',
      firstName: 'Prestataire',
      lastName: 'Seed',
      email: 'provider.seed@liyanza.local',
      password: providerPasswordHash,
      phone: '+237600000003',
      role: Role.PROVIDER,
      companyId: company.id,
    },
  });

  // ---------------------------------------------------------------------
  // 3. Campagne + canal de diffusion d'exemple (tests manuels dès la Phase 2)
  // ---------------------------------------------------------------------
  const campaign = await prisma.campaign.upsert({
    where: { id: 'seed-campaign-1' },
    update: {},
    create: {
      id: 'seed-campaign-1',
      name: 'Campagne de lancement — Produit Demo',
      startDate: new Date('2026-09-01T00:00:00.000Z'),
      endDate: new Date('2026-09-30T23:59:59.000Z'),
      plannedBudget: 1_500_000,
      actualBudget: 0,
      status: CampaignStatus.PLANNED,
      objective: 'Accroître la notoriété du produit Demo à Douala',
      launchedById: marketingManager.id,
    },
  });

  await prisma.advertisingChannel.upsert({
    where: { id: 'seed-channel-1' },
    update: {},
    create: {
      id: 'seed-channel-1',
      radio: true,
      poster: true,
      flyer: false,
      campaignId: campaign.id,
    },
  });

  console.log('[seed] Terminé avec succès ✅');
  console.log('[seed] Comptes de test disponibles (local uniquement) :');
  console.table([
    { role: 'ADMIN', email: admin.email, password: SEED_PASSWORDS.admin },
    {
      role: 'MARKETING_MANAGER',
      email: marketingManager.email,
      password: SEED_PASSWORDS.marketingManager,
    },
    {
      role: 'PROVIDER',
      email: provider.email,
      password: SEED_PASSWORDS.provider,
    },
  ]);
}

main()
  .catch((error: unknown) => {
    console.error('[seed] Échec du seed :', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
