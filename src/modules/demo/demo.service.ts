import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { randomBytes } from 'crypto';
import {
  BudgetAllocationType,
  CampaignStatus,
  CampaignType,
  DigitalObjective,
  Prisma,
  QrCodeTargetType,
  Role,
  SocialPlatform,
  TaskStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DigitalSimulationEngineHeuristic } from '../digital-campaigns/clients/digital-simulation-engine.heuristic';
import type { DigitalSimulationParameters } from '../digital-campaigns/clients/digital-simulation-engine.interface';
import {
  DEMO_COMPANY,
  DEMO_EMAIL_DOMAIN,
  DEMO_USER_EMAIL,
  isDemoEnabled,
} from './demo.constants';
import {
  DAY,
  DEMO_POSTER_SITES,
  HOUR,
  MINUTE,
  buildBroadcastPlan,
  createRng,
  demoPosterPhoto,
  doualaMidnight,
  offsetCoordinates,
} from './demo-data';

type Tx = Prisma.TransactionClient;

/** Âge maximal des données de démo avant une remise à zéro au démarrage. */
export const DEMO_MAX_AGE_MS = 24 * HOUR;

/**
 * Verrou consultatif PostgreSQL (`pg_try_advisory_xact_lock`) : si deux
 * instances démarrent ensemble, une seule remet la démo à zéro, l'autre
 * passe son tour au lieu de tout recréer en double.
 */
const DEMO_RESET_LOCK_KEY = 724_519_031;

interface DemoMember {
  email: string;
  firstName: string;
  lastName: string;
  role: Role;
  phone: string;
}

/** Le compte du visiteur, puis l'équipe (sans connexion possible). */
const DEMO_MEMBERS: DemoMember[] = [
  {
    email: DEMO_USER_EMAIL,
    firstName: 'Visiteur',
    lastName: 'Démo',
    role: Role.ADMIN,
    phone: '+237 6 99 00 00 01',
  },
  {
    email: `aminatou.bello@${DEMO_EMAIL_DOMAIN}`,
    firstName: 'Aminatou',
    lastName: 'Bello',
    role: Role.MARKETING_MANAGER,
    phone: '+237 6 99 00 00 02',
  },
  {
    email: `junior.ekane@${DEMO_EMAIL_DOMAIN}`,
    firstName: 'Junior',
    lastName: 'Ekane',
    role: Role.COMMUNITY_MANAGER,
    phone: '+237 6 99 00 00 03',
  },
];

export interface DemoResetSummary {
  companyId: string;
  campaigns: number;
  broadcasts: number;
  installations: number;
  proofs: number;
  qrCodes: number;
  qrScans: number;
  digitalSimulations: number;
  recommendations: number;
  members: number;
  tasks: number;
  notifications: number;
  conversations: number;
}

/**
 * Démo publique (« Voir la démo » du site, aussi utilisée par les
 * relecteurs de Meta) : une entreprise fictive, « Brasserie Sawa (démo) »,
 * dont les données sont entièrement recréées par `reset()` :
 * - au démarrage, si l'entreprise manque ou si ses données ont plus de 24 h ;
 * - chaque nuit à 03:30 (heure de Douala).
 *
 * SÉCURITÉ : chaque suppression est restreinte à l'entreprise `isDemo` —
 * jamais une donnée d'une entreprise réelle (voir `wipe()` et ses tests).
 * L'entreprise et ses comptes sont conservés d'une remise à zéro à l'autre
 * (mêmes identifiants) : les sessions des visiteurs en cours survivent.
 */
@Injectable()
export class DemoService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DemoService.name);
  private readonly simulationEngine = new DigitalSimulationEngineHeuristic();

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {}

  /**
   * Ne bloque jamais le démarrage : la remise à zéro tourne en arrière-plan
   * et `POST /auth/demo` répond 503 tant qu'elle n'est pas terminée.
   */
  onApplicationBootstrap(): void {
    if (!isDemoEnabled(this.config)) return;
    void this.resetIfStale().catch((error: unknown) => {
      this.logger.error(
        'Demo reset at boot failed',
        error instanceof Error ? error.stack : String(error),
      );
    });
  }

  @Cron('30 3 * * *', { timeZone: 'Africa/Douala' })
  async nightlyReset(): Promise<void> {
    if (!isDemoEnabled(this.config)) return;
    try {
      await this.reset();
    } catch (error) {
      this.logger.error(
        'Nightly demo reset failed',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * Remise à zéro si l'entreprise de démo n'existe pas, si son compte
   * visiteur manque, ou si ses données datent de plus de 24 h. `updatedAt`
   * de l'entreprise sert d'horodatage : seule la remise à zéro la modifie
   * (la démo est en lecture seule).
   */
  async resetIfStale(now: Date = new Date()): Promise<boolean> {
    const company = await this.prisma.company.findFirst({
      where: { isDemo: true },
      select: { id: true, updatedAt: true },
    });
    const visitor = company
      ? await this.prisma.user.findUnique({
          where: { email: DEMO_USER_EMAIL },
          select: { companyId: true },
        })
      : null;
    const fresh =
      company &&
      visitor?.companyId === company.id &&
      now.getTime() - company.updatedAt.getTime() < DEMO_MAX_AGE_MS;
    if (fresh) return false;

    await this.reset(now);
    return true;
  }

  /**
   * Supprime puis recrée toutes les données de l'entreprise de démo, en une
   * transaction (aucun visiteur ne voit une démo à moitié vide). Idempotent.
   * `null` si une autre instance est déjà en train de le faire.
   */
  async reset(now: Date = new Date()): Promise<DemoResetSummary | null> {
    const summary = await this.prisma.$transaction(
      async (tx) => {
        const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(${DEMO_RESET_LOCK_KEY}::bigint) AS locked`;
        if (!lock?.locked) return null;

        const companyId = await this.upsertCompany(tx, now);
        const members = await this.upsertMembers(tx, companyId);
        await this.wipe(tx, companyId);
        return this.seed(tx, companyId, members, now);
      },
      { maxWait: 10_000, timeout: 120_000 },
    );

    if (summary) {
      this.logger.log(
        `Demo company reset: ${summary.campaigns} campaigns, ${summary.broadcasts} broadcasts, ${summary.installations} installations.`,
      );
    } else {
      this.logger.log('Demo reset skipped: another instance is running it.');
    }
    return summary;
  }

  // ------------------------------------------------------------------
  // Entreprise & comptes
  // ------------------------------------------------------------------

  /**
   * Formule PRO via l'essai (`trialEndsAt` à un an, repoussé à chaque
   * remise à zéro) : les fonctions avancées sont visibles dans la démo.
   */
  private async upsertCompany(tx: Tx, now: Date): Promise<string> {
    const data = {
      ...DEMO_COMPANY,
      deletedAt: null,
      trialEndsAt: new Date(now.getTime() + 365 * DAY),
      // Touché explicitement : c'est l'horodatage de la dernière remise à
      // zéro, lu par `resetIfStale()`.
      updatedAt: now,
    };
    const existing = await tx.company.findFirst({
      where: { isDemo: true },
      select: { id: true },
    });
    if (existing) {
      await tx.company.update({ where: { id: existing.id }, data });
      return existing.id;
    }
    const created = await tx.company.create({
      data: { ...data, isDemo: true },
      select: { id: true },
    });
    return created.id;
  }

  /**
   * Comptes de la démo, sans mot de passe ni compte Google/Facebook : aucun
   * ne peut se connecter autrement que par `POST /auth/demo` (le visiteur)
   * — les autres ne se connectent jamais. Une adresse déjà prise par un
   * compte d'une AUTRE entreprise n'est jamais récupérée : on abandonne.
   */
  private async upsertMembers(
    tx: Tx,
    companyId: string,
  ): Promise<{ id: string; role: Role; firstName: string }[]> {
    const members: { id: string; role: Role; firstName: string }[] = [];
    for (const member of DEMO_MEMBERS) {
      const existing = await tx.user.findUnique({
        where: { email: member.email },
        select: { id: true, companyId: true },
      });
      if (existing?.companyId && existing.companyId !== companyId) {
        throw new Error(
          `Demo reset aborted: ${member.email} belongs to another company.`,
        );
      }
      const data = {
        firstName: member.firstName,
        lastName: member.lastName,
        role: member.role,
        phone: member.phone,
        password: null,
        googleId: null,
        facebookId: null,
        deactivatedAt: null,
        companyId,
      };
      const user = existing
        ? await tx.user.update({
            where: { id: existing.id },
            data,
            select: { id: true, role: true, firstName: true },
          })
        : await tx.user.create({
            data: { ...data, email: member.email },
            select: { id: true, role: true, firstName: true },
          });
      members.push(user);
    }
    return members;
  }

  /**
   * Efface les données de l'entreprise de démo, dans l'ordre des clés
   * étrangères. CHAQUE filtre passe par `companyId` (directement ou via
   * l'auteur de la campagne, comme partout ailleurs) : jamais de
   * `deleteMany` sans périmètre.
   */
  async wipe(tx: Tx, companyId: string): Promise<void> {
    if (!companyId) {
      throw new Error('Demo wipe requires the demo company id.');
    }
    const inCompanyCampaign = { campaign: { launchedBy: { companyId } } };
    const companyConversations = {
      OR: [{ companyId }, { createdBy: { companyId } }],
    };

    await tx.qrCodeScan.deleteMany({ where: { qrCode: inCompanyCampaign } });
    await tx.qrCode.deleteMany({ where: inCompanyCampaign });
    await tx.statusHistory.deleteMany({
      where: { installation: inCompanyCampaign },
    });
    await tx.publicationProof.deleteMany({
      where: { installation: inCompanyCampaign },
    });
    await tx.installation.deleteMany({ where: inCompanyCampaign });
    await tx.broadcast.deleteMany({ where: inCompanyCampaign });
    await tx.advertisingChannel.deleteMany({ where: inCompanyCampaign });
    await tx.statistic.deleteMany({ where: inCompanyCampaign });
    await tx.recommendation.deleteMany({
      where: { OR: [inCompanyCampaign, { companyId }] },
    });
    await tx.taskAssignee.deleteMany({ where: { task: { companyId } } });
    await tx.task.deleteMany({ where: { companyId } });
    await tx.digitalCampaignChannel.deleteMany({
      where: {
        OR: [
          { digitalCampaignDetails: inCompanyCampaign },
          { socialAccount: { companyId } },
        ],
      },
    });
    await tx.digitalCampaignDetails.deleteMany({ where: inCompanyCampaign });
    await tx.digitalSimulation.deleteMany({ where: inCompanyCampaign });
    await tx.campaignAlert.deleteMany({ where: inCompanyCampaign });
    await tx.adPerformanceObservation.deleteMany({ where: inCompanyCampaign });
    await tx.aiMessage.deleteMany({
      where: { conversation: companyConversations },
    });
    await tx.aiConversation.deleteMany({ where: companyConversations });
    await tx.notification.deleteMany({ where: { recipient: { companyId } } });
    await tx.platformMetric.deleteMany({
      where: { socialAccount: { companyId } },
    });
    await tx.socialAccount.deleteMany({ where: { companyId } });
    await tx.media.deleteMany({ where: { companyId } });
    await tx.campaign.deleteMany({ where: { launchedBy: { companyId } } });
  }

  // ------------------------------------------------------------------
  // Données
  // ------------------------------------------------------------------

  private async seed(
    tx: Tx,
    companyId: string,
    members: { id: string; role: Role; firstName: string }[],
    now: Date,
  ): Promise<DemoResetSummary> {
    const [visitor, marketing, community] = members;
    const at = (days: number, hours = 0) =>
      new Date(now.getTime() + days * DAY + hours * HOUR);

    // --- 1. Campagne radio en cours ----------------------------------
    const radioStart = doualaMidnight(now, -21);
    const radioDays = 21 + 14 + 1;
    const radio = await tx.campaign.create({
      data: {
        name: 'Sawa Fraîche — Radio Balafon FM',
        type: CampaignType.RADIO,
        status: CampaignStatus.IN_PROGRESS,
        objective: 'Diffusion radio — Radio Balafon FM',
        startDate: radioStart,
        endDate: new Date(doualaMidnight(now, 15).getTime() - MINUTE),
        plannedBudget: 1_800_000,
        actualBudget: 1_050_000,
        launchedById: visitor.id,
        createdAt: at(-26),
      },
    });
    const radioChannel = await tx.advertisingChannel.create({
      data: { radio: true, poster: false, flyer: false, campaignId: radio.id },
    });
    const radioBroadcasts = buildBroadcastPlan({
      firstDay: radioStart,
      days: radioDays,
      slots: [
        [7, 15],
        [18, 30],
      ],
      saturdaySlot: [12, 0],
      now,
      seed: 20_260_301,
      cancelledPastIndexes: [20],
      cancelledFutureIndexes: [4],
    });

    // --- 2. Campagne terminée (radio, il y a 4 mois) ------------------
    const completedStart = doualaMidnight(now, -120);
    const completed = await tx.campaign.create({
      data: {
        name: 'Fête de la Musique — Sawa Lager',
        type: CampaignType.RADIO,
        status: CampaignStatus.COMPLETED,
        objective: 'Diffusion radio — Radio Balafon FM',
        startDate: completedStart,
        endDate: new Date(doualaMidnight(now, -90).getTime() - MINUTE),
        plannedBudget: 900_000,
        actualBudget: 870_000,
        launchedById: marketing.id,
        createdAt: at(-125),
      },
    });
    const completedChannel = await tx.advertisingChannel.create({
      data: {
        radio: true,
        poster: false,
        flyer: false,
        campaignId: completed.id,
      },
    });
    const completedBroadcasts = buildBroadcastPlan({
      firstDay: completedStart,
      days: 30,
      slots: [[12, 30]],
      now,
      seed: 20_260_621,
    });

    await tx.broadcast.createMany({
      data: [
        ...radioBroadcasts.map((b) => ({
          ...b,
          mediaType: 'RADIO',
          campaignId: radio.id,
          channelId: radioChannel.id,
        })),
        ...completedBroadcasts.map((b) => ({
          ...b,
          mediaType: 'RADIO',
          campaignId: completed.id,
          channelId: completedChannel.id,
        })),
      ],
    });

    // --- 3. Campagne d'affichage en cours -----------------------------
    const poster = await tx.campaign.create({
      data: {
        name: 'Sawa Lager — Affichage Douala & Yaoundé',
        type: CampaignType.POSTER,
        status: CampaignStatus.IN_PROGRESS,
        objective:
          'Affichage — Sawa Lager. Rendre la bouteille verte visible aux grands carrefours de Douala et Yaoundé avant les fêtes.',
        startDate: doualaMidnight(now, -10),
        endDate: new Date(doualaMidnight(now, 21).getTime() - MINUTE),
        plannedBudget: 2_400_000,
        actualBudget: 1_320_000,
        launchedById: visitor.id,
        createdAt: at(-14),
      },
    });
    await tx.advertisingChannel.create({
      data: { radio: false, poster: true, flyer: false, campaignId: poster.id },
    });

    let proofs = 0;
    const installationIds: string[] = [];
    for (const site of DEMO_POSTER_SITES) {
      const plannedDate = new Date(
        doualaMidnight(now, site.plannedInDays).getTime() + 9 * HOUR,
      );
      const takenAt = new Date(plannedDate.getTime() + 2 * HOUR + 17 * MINUTE);
      const reviewedAt = new Date(takenAt.getTime() + 20 * HOUR);
      const history: Prisma.StatusHistoryCreateWithoutInstallationInput[] = [];
      let status = 'PLANNED';
      let proof: Prisma.PublicationProofCreateWithoutInstallationInput | null =
        null;

      if (site.state !== 'PLANNED') {
        const point = offsetCoordinates(
          site.latitude,
          site.longitude,
          site.proofOffsetMeters ?? 0,
          site.proofBearing ?? 0,
        );
        const reviewed = site.state !== 'PENDING_REVIEW';
        proof = {
          photo: demoPosterPhoto(site.photo ?? 1),
          latitude: point.latitude,
          longitude: point.longitude,
          takenAt,
          validationStatus: reviewed ? site.state : 'PENDING',
          validationComment: site.comment ?? null,
          createdAt: takenAt,
        };
        proofs++;
        status = 'INSTALLED';
        history.push({
          previousStatus: 'PLANNED',
          newStatus: 'INSTALLED',
          changedAt: takenAt,
          comment: 'Preuve envoyée par le poseur (lien de preuve).',
        });
        if (reviewed) {
          status = site.state;
          history.push({
            previousStatus: 'INSTALLED',
            newStatus: site.state,
            changedAt: reviewedAt,
            comment: site.comment ?? 'Preuve validée.',
          });
        }
      }

      const installation = await tx.installation.create({
        data: {
          location: site.location,
          plannedLatitude: site.latitude,
          plannedLongitude: site.longitude,
          plannedInstallationDate: plannedDate,
          status,
          campaignId: poster.id,
          createdAt: at(-12),
          ...(proof && { proof: { create: proof } }),
          ...(history.length > 0 && {
            statusHistory: { create: history },
          }),
        },
        select: { id: true },
      });
      installationIds.push(installation.id);
    }

    // QR codes posés sur trois panneaux, avec leurs scans (onglet QR).
    const qrSpecs = [
      { index: 0, zone: 'Akwa', scans: 46 },
      { index: 1, zone: 'Bonapriso', scans: 23 },
      { index: 4, zone: 'Bastos', scans: 31 },
    ];
    const rng = createRng(20_261_013);
    let qrScans = 0;
    for (const spec of qrSpecs) {
      const qr = await tx.qrCode.create({
        data: {
          code: `demo${randomBytes(6).toString('base64url')}`,
          targetType: QrCodeTargetType.PROMO,
          targetUrl: 'https://www.kiyanza.com',
          zone: spec.zone,
          campaignId: poster.id,
          installationId: installationIds[spec.index],
          createdAt: at(-9),
        },
        select: { id: true },
      });
      await tx.qrCodeScan.createMany({
        data: Array.from({ length: spec.scans }, () => ({
          qrCodeId: qr.id,
          // Scans répartis sur les 8 derniers jours, en journée.
          scannedAt: new Date(
            doualaMidnight(now, -1 - Math.floor(rng() * 8)).getTime() +
              (8 + rng() * 13) * HOUR,
          ),
        })),
      });
      qrScans += spec.scans;
    }

    // --- 4. Campagne digitale (Facebook & Instagram) -------------------
    const digital = await tx.campaign.create({
      data: {
        name: 'Lancement Sawa Zéro — Facebook & Instagram',
        type: CampaignType.DIGITAL,
        status: CampaignStatus.PLANNED,
        objective:
          'Notoriété — Faire connaître Sawa Zéro, la nouvelle bière sans alcool, aux 18-35 ans de Douala et Yaoundé.',
        startDate: doualaMidnight(now, 5),
        endDate: new Date(doualaMidnight(now, 33).getTime() - MINUTE),
        plannedBudget: 750_000,
        actualBudget: 0,
        launchedById: community.id,
        createdAt: at(-4),
      },
    });
    const details = await tx.digitalCampaignDetails.create({
      data: {
        campaignId: digital.id,
        objective: DigitalObjective.AWARENESS,
        customObjective:
          'Faire connaître Sawa Zéro aux 18-35 ans de Douala et Yaoundé',
        ageMin: 18,
        ageMax: 35,
        targetGender: 'ALL',
        targetLocations: ['Douala', 'Yaoundé'],
        targetInterests: ['Musique', 'Football', 'Sorties entre amis', 'Sport'],
        budgetAllocation: BudgetAllocationType.TOTAL,
      },
    });
    await tx.digitalCampaignChannel.createMany({
      data: [SocialPlatform.FACEBOOK, SocialPlatform.INSTAGRAM].map(
        (platform) => ({ platform, digitalCampaignDetailsId: details.id }),
      ),
    });
    await this.seedDigitalSimulation(tx, digital.id, at(-3));

    // --- 5. Brouillon -------------------------------------------------
    await tx.campaign.create({
      data: {
        name: 'Promo fin d’année — Sawa Prestige',
        type: CampaignType.RADIO,
        status: CampaignStatus.DRAFT,
        objective: 'Diffusion radio — Radio Balafon FM',
        startDate: doualaMidnight(now, 40),
        endDate: new Date(doualaMidnight(now, 70).getTime() - MINUTE),
        plannedBudget: 1_200_000,
        actualBudget: 0,
        launchedById: marketing.id,
        createdAt: at(-1),
      },
    });

    // --- 6. Recommandations IA (comme générées) -----------------------
    const recommendations = [
      {
        title: 'Renforcer le créneau de 18h30',
        content:
          "Les diffusions de 18h30 sont celles qui touchent le plus d'actifs sur le retour du travail. Ajoutez un passage à 19h15 en semaine pendant les deux dernières semaines, financé par la suppression du créneau du samedi midi, moins écouté.",
        priority: 'high',
        category: 'timing',
      },
      {
        title: 'Exiger un rattrapage des diffusions manquées',
        content:
          'Plusieurs diffusions ont été manquées et certaines sont passées avec plus de 15 minutes de retard. Demandez à Radio Balafon FM un rattrapage gratuit à horaire équivalent, comme le prévoit habituellement le bon de commande.',
        priority: 'high',
        category: 'radio',
      },
      {
        title: 'Associer un QR code au spot radio',
        content:
          "Mentionnez à l'antenne le code promo affiché sur les panneaux de la campagne d'affichage : vous pourrez mesurer l'effet combiné radio + affichage via les scans de QR code.",
        priority: 'medium',
        category: 'measurement',
      },
      {
        title: 'Réserver 15 % du budget restant au digital',
        content:
          'Le reste à dépenser sur la radio permet de financer une courte campagne Facebook ciblant Douala pendant la dernière semaine, pour prolonger la mémorisation du spot auprès des 18-35 ans.',
        priority: 'low',
        category: 'budget',
      },
    ];
    await tx.recommendation.createMany({
      data: recommendations.map((rec) => ({
        ...rec,
        generatedAt: at(-2, -3),
        campaignId: radio.id,
        companyId,
      })),
    });

    // --- 7. Tâches -----------------------------------------------------
    // `reminderSentAt` renseigné et retards déjà en LATE : le planificateur
    // des tâches n'a rien à relancer sur la démo.
    const tasks = [
      {
        title: 'Valider la preuve du panneau de Bonamoussadi',
        description:
          'La photo du poseur est arrivée : vérifier la visibilité de la bouteille, puis valider ou refuser.',
        status: TaskStatus.TODO,
        dueDate: at(1),
        assignee: marketing.id,
        campaignId: poster.id,
      },
      {
        title: 'Obtenir le rattrapage des diffusions manquées',
        description:
          'Appeler la régie de Radio Balafon FM avec le rapport de conformité.',
        status: TaskStatus.IN_PROGRESS,
        dueDate: at(2),
        assignee: marketing.id,
        campaignId: radio.id,
      },
      {
        title: 'Préparer les visuels Instagram de Sawa Zéro',
        description: '3 visuels carrés et 2 stories, charte verte.',
        status: TaskStatus.LATE,
        dueDate: at(-1),
        assignee: community.id,
        campaignId: digital.id,
      },
      {
        title: 'Envoyer le bilan de la Fête de la Musique',
        description: null,
        status: TaskStatus.DONE,
        dueDate: at(-85),
        assignee: community.id,
        campaignId: completed.id,
      },
    ];
    for (const task of tasks) {
      await tx.task.create({
        data: {
          title: task.title,
          description: task.description,
          status: task.status,
          dueDate: task.dueDate,
          reminderSentAt: now,
          companyId,
          createdById: visitor.id,
          campaignId: task.campaignId,
          assignees: { create: [{ userId: task.assignee }] },
        },
      });
    }

    // --- 8. Notifications du visiteur ---------------------------------
    const lateBroadcast = radioBroadcasts.find(
      (b) =>
        b.actualBroadcastAt &&
        b.actualBroadcastAt.getTime() - b.scheduledAt.getTime() > 15 * MINUTE,
    );
    const lateMinutes = lateBroadcast?.actualBroadcastAt
      ? Math.round(
          (lateBroadcast.actualBroadcastAt.getTime() -
            lateBroadcast.scheduledAt.getTime()) /
            MINUTE,
        )
      : 22;
    const notifications = [
      {
        title: 'Bienvenue dans la démo Kiyanza',
        message:
          'Vous explorez Brasserie Sawa, une entreprise fictive, en lecture seule. Parcourez les campagnes, le suivi des diffusions et des affichages, et posez vos questions au Copilot.',
        type: 'INFO',
        sentAt: now,
        readStatus: 'UNREAD',
      },
      {
        title: 'Nouvelle preuve à valider',
        message:
          'Le poseur a envoyé la photo du panneau « Bonamoussadi — Carrefour Bonamoussadi, Douala ».',
        type: 'INFO',
        sentAt: at(-3, 3),
        readStatus: 'UNREAD',
      },
      {
        title: 'Écart de diffusion détecté',
        message: `La diffusion "RADIO" de la campagne "${radio.name}" a été détectée avec un écart de ${lateMinutes} minute(s) par rapport à l'horaire planifié.`,
        type: 'WARNING',
        sentAt: lateBroadcast?.actualBroadcastAt ?? at(-2),
        readStatus: 'UNREAD',
      },
      {
        title: 'Preuve refusée',
        message:
          'La preuve du panneau « Deido — Rond-point Deido, Douala » a été refusée : photo à reprendre.',
        type: 'ERROR',
        sentAt: at(-5),
        readStatus: 'READ',
      },
      {
        title: 'Preuve validée',
        message:
          'Le panneau « Akwa — Boulevard de la Liberté, Douala » est posé et validé.',
        type: 'SUCCESS',
        sentAt: at(-8),
        readStatus: 'READ',
      },
    ];
    await tx.notification.createMany({
      data: notifications.map((n) => ({ ...n, recipientId: visitor.id })),
    });

    // --- 9. Une conversation d'exemple avec le Copilot ----------------
    // Datée d'hier : n'entame pas le quota du jour.
    const conversationAt = at(-1, -2);
    await tx.aiConversation.create({
      data: {
        topic: 'Bilan de la campagne Radio Balafon FM',
        startedAt: conversationAt,
        lastMessageAt: new Date(conversationAt.getTime() + MINUTE),
        companyId,
        createdById: visitor.id,
        messages: {
          create: [
            {
              sender: 'USER',
              content:
                'Comment se passe ma campagne sur Radio Balafon FM pour le moment ?',
              sentAt: conversationAt,
            },
            {
              sender: 'AI',
              content:
                "Votre campagne « Sawa Fraîche » est à mi-parcours. La grande majorité des spots prévus ont bien été diffusés, mais quelques-uns ont été manqués et certains sont passés avec plus de 15 minutes de retard, surtout sur le créneau du soir.\n\nJe vous conseille de :\n1. demander à la radio un rattrapage des diffusions manquées ;\n2. surveiller le créneau de 18h30, le plus écouté mais aussi le plus souvent décalé ;\n3. comparer avec les scans des QR codes de votre affichage pour mesurer l'effet combiné.",
              sentAt: new Date(conversationAt.getTime() + MINUTE),
            },
          ],
        },
      },
    });

    return {
      companyId,
      campaigns: 5,
      broadcasts: radioBroadcasts.length + completedBroadcasts.length,
      installations: installationIds.length,
      proofs,
      qrCodes: qrSpecs.length,
      qrScans,
      digitalSimulations: 1,
      recommendations: recommendations.length,
      members: members.length,
      tasks: tasks.length,
      notifications: notifications.length,
      conversations: 1,
    };
  }

  /**
   * Simulation calculée par le vrai moteur (heuristique, sans réseau) ; seule
   * l'analyse IA est écrite à la main, pour ne jamais appeler le LLM depuis
   * la démo.
   */
  private async seedDigitalSimulation(
    tx: Tx,
    campaignId: string,
    simulatedAt: Date,
  ): Promise<void> {
    const parameters: DigitalSimulationParameters = {
      objective: DigitalObjective.AWARENESS,
      customObjective:
        'Faire connaître Sawa Zéro aux 18-35 ans de Douala et Yaoundé',
      budget: { amount: 750_000, allocation: BudgetAllocationType.TOTAL },
      audience: {
        ageMin: 18,
        ageMax: 35,
        targetGender: 'ALL',
        locations: ['Douala', 'Yaoundé'],
        interests: ['Musique', 'Football', 'Sorties entre amis', 'Sport'],
      },
      channels: [
        { platform: 'FACEBOOK', metrics: null },
        { platform: 'INSTAGRAM', metrics: null },
      ],
      calibration: null,
    };
    const result = await this.simulationEngine.simulate(parameters);
    const aiAnalysis = {
      summary:
        'Avec 750 000 FCFA sur quatre semaines, la campagne peut toucher une large part des 18-35 ans connectés de Douala et Yaoundé. Facebook apporte l’essentiel de la portée à moindre coût ; Instagram renforce l’image de marque auprès des plus jeunes.',
      strengths: [
        'Budget suffisant pour répéter le message plusieurs fois auprès de la même audience.',
        'Centres d’intérêt (musique, football) très partagés par la cible.',
      ],
      risks: [
        'Aucune Page Facebook reliée : les estimations reposent sur les références du marché camerounais.',
        'Une audience trop large dilue la mémorisation d’un nouveau produit.',
      ],
      recommendations: [
        {
          title: 'Relier la Page Facebook de la marque',
          detail:
            'La simulation utilisera alors vos vraies statistiques d’audience et deviendra plus précise.',
        },
        {
          title: 'Concentrer les deux premières semaines sur Douala',
          detail:
            'Le lancement y est soutenu par l’affichage et la radio : la répétition y sera plus efficace.',
        },
      ],
      scenarioChoice:
        'Le scénario recommandé garde vos réglages : c’est le meilleur compromis entre portée et coût par personne touchée.',
    };

    await tx.digitalSimulation.create({
      data: {
        campaignId,
        simulatedAt,
        inputSnapshot: parameters as unknown as Prisma.InputJsonValue,
        predictedReach: result.predictedReach,
        predictedEngagementRate: result.predictedEngagementRate,
        predictedCtr: result.predictedCtr,
        predictedRoas: result.predictedRoas,
        narrativeSummary: aiAnalysis.summary,
        warnings: result.warnings,
        avgCpc: result.avgCpc,
        costPerAcquisition: result.costPerAcquisition,
        conversionRate: result.conversionRate,
        scenarios: result.scenarios as unknown as Prisma.InputJsonValue,
        channelBreakdown:
          result.channelBreakdown as unknown as Prisma.InputJsonValue,
        weeklySeries: result.weeklySeries as unknown as Prisma.InputJsonValue,
        aiAnalysis: aiAnalysis,
      },
    });
  }
}
