import { BroadcastStatus } from '@prisma/client';

/**
 * Données de la démo publique, construites RELATIVEMENT à l'heure de la
 * remise à zéro (`now`) : la démo paraît toujours en cours, quel que soit
 * le jour de la visite. Fonctions pures (aucun accès base), testées à part
 * de `DemoService` qui les écrit.
 */

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Douala (Africa/Douala) : UTC+1 toute l'année, sans heure d'été. */
const DOUALA_UTC_OFFSET_HOURS = 1;

/** Image publique des preuves d'affichage (fichiers servis par le site). */
export const demoPosterPhoto = (index: number) =>
  `https://www.kiyanza.com/demo/affiche-${index}.jpg`;

/**
 * Générateur pseudo-aléatoire déterministe (mulberry32) : mêmes écarts de
 * diffusion à chaque remise à zéro, donc une démo stable d'un jour à
 * l'autre et des tests reproductibles.
 */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Minuit (heure de Douala) du jour local de `date`, décalé de `days` jours. */
export function doualaMidnight(date: Date, days = 0): Date {
  const local = new Date(date.getTime() + DOUALA_UTC_OFFSET_HOURS * HOUR);
  return new Date(
    Date.UTC(
      local.getUTCFullYear(),
      local.getUTCMonth(),
      local.getUTCDate() + days,
    ) -
      DOUALA_UTC_OFFSET_HOURS * HOUR,
  );
}

/** Heure locale de Douala `hours:minutes` le jour qui commence à `midnight`. */
export function atDoualaTime(
  midnight: Date,
  hours: number,
  minutes: number,
): Date {
  return new Date(midnight.getTime() + hours * HOUR + minutes * MINUTE);
}

/** Jour de la semaine (0 = dimanche) d'un minuit de Douala. */
const doualaWeekday = (midnight: Date) =>
  new Date(midnight.getTime() + DOUALA_UTC_OFFSET_HOURS * HOUR).getUTCDay();

export interface DemoBroadcast {
  scheduledAt: Date;
  actualBroadcastAt: Date | null;
  status: BroadcastStatus;
  duration: number;
}

/**
 * Seuil (minutes) au-delà duquel le suivi signale un écart — miroir de
 * `DEVIATION_ALERT_THRESHOLD_MINUTES` (MonitoringService).
 */
export const DEMO_LATE_THRESHOLD_MINUTES = 15;

interface BroadcastPlanOptions {
  /** Premier jour (minuit de Douala) et nombre de jours couverts. */
  firstDay: Date;
  days: number;
  /** Créneaux quotidiens, heure de Douala. */
  slots: Array<[number, number]>;
  /** Créneau ajouté le samedi (émission du week-end), facultatif. */
  saturdaySlot?: [number, number];
  now: Date;
  seed: number;
  /** Indices (diffusions passées) annulés d'un commun accord avec la radio. */
  cancelledPastIndexes?: number[];
  /** Indices (diffusions futures) annulés. */
  cancelledFutureIndexes?: number[];
}

/**
 * Plan de diffusion radio réaliste : les diffusions passées sont en grande
 * majorité diffusées, à quelques minutes près (certaines avec plus de 15
 * minutes de retard, d'où des alertes), quelques-unes manquées ; les
 * futures restent planifiées. Motifs fixes par indice (plutôt que purement
 * aléatoires) : la démo montre toujours des retards et des manques, quelle
 * que soit l'heure de la remise à zéro.
 */
export function buildBroadcastPlan(
  options: BroadcastPlanOptions,
): DemoBroadcast[] {
  const rng = createRng(options.seed);
  const scheduled: Date[] = [];
  for (let day = 0; day < options.days; day++) {
    const midnight = new Date(options.firstDay.getTime() + day * DAY);
    const slots = [...options.slots];
    if (options.saturdaySlot && doualaWeekday(midnight) === 6) {
      slots.push(options.saturdaySlot);
    }
    slots.sort((a, b) => a[0] * 60 + a[1] - (b[0] * 60 + b[1]));
    for (const [hours, minutes] of slots) {
      scheduled.push(atDoualaTime(midnight, hours, minutes));
    }
  }

  const cancelledPast = new Set(options.cancelledPastIndexes ?? []);
  const cancelledFuture = new Set(options.cancelledFutureIndexes ?? []);
  let pastIndex = 0;
  let futureIndex = 0;

  return scheduled.map((scheduledAt) => {
    // Tirages consommés pour chaque diffusion, passée ou non : les écarts
    // ne dépendent que de la position dans le plan.
    const jitter = rng();
    const lateness = rng();

    if (scheduledAt.getTime() >= options.now.getTime()) {
      const index = futureIndex++;
      return {
        scheduledAt,
        actualBroadcastAt: null,
        status: cancelledFuture.has(index)
          ? BroadcastStatus.CANCELLED
          : BroadcastStatus.PLANNED,
        duration: 30,
      };
    }

    const index = pastIndex++;
    if (cancelledPast.has(index)) {
      return {
        scheduledAt,
        actualBroadcastAt: null,
        status: BroadcastStatus.CANCELLED,
        duration: 30,
      };
    }
    if (index % 13 === 5) {
      return {
        scheduledAt,
        actualBroadcastAt: null,
        status: BroadcastStatus.MISSED,
        duration: 30,
      };
    }

    // Retard notable (16 à 42 min) une fois sur sept ; sinon de 4 min
    // d'avance à 9 min de retard, secondes comprises.
    const deviationMs =
      index % 7 === 3
        ? (16 + Math.floor(lateness * 27)) * MINUTE
        : Math.round((-4 + jitter * 13) * MINUTE);
    let actual = new Date(scheduledAt.getTime() + deviationMs);
    // Une diffusion constatée ne peut pas l'être dans le futur.
    if (actual.getTime() > options.now.getTime()) {
      actual = new Date(scheduledAt.getTime());
    }
    return {
      scheduledAt,
      actualBroadcastAt: actual,
      status: BroadcastStatus.BROADCASTED,
      duration: 30,
    };
  });
}

/**
 * Point situé à `meters` mètres de (`lat`, `lng`) dans la direction
 * `bearingDeg` (0 = nord). Approximation plane, exacte à quelques
 * centimètres près sur ces distances.
 */
export function offsetCoordinates(
  lat: number,
  lng: number,
  meters: number,
  bearingDeg: number,
): { latitude: number; longitude: number } {
  const bearing = (bearingDeg * Math.PI) / 180;
  const metersPerDegreeLat = 111_320;
  const metersPerDegreeLng = 111_320 * Math.cos((lat * Math.PI) / 180);
  return {
    latitude: lat + (meters * Math.cos(bearing)) / metersPerDegreeLat,
    longitude: lng + (meters * Math.sin(bearing)) / metersPerDegreeLng,
  };
}

export type DemoPosterState =
  'VALIDATED' | 'PENDING_REVIEW' | 'REJECTED' | 'PLANNED';

export interface DemoPosterSite {
  location: string;
  latitude: number;
  longitude: number;
  state: DemoPosterState;
  /** Jours entre `now` et la pose prévue (négatif : passée). */
  plannedInDays: number;
  /** Écart GPS de la photo (mètres) et sa direction. */
  proofOffsetMeters?: number;
  proofBearing?: number;
  /** N° de l'image `affiche-N.jpg`. */
  photo?: number;
  comment?: string;
}

/** Panneaux de la campagne d'affichage — vrais quartiers de Douala/Yaoundé. */
export const DEMO_POSTER_SITES: DemoPosterSite[] = [
  {
    location: 'Akwa — Boulevard de la Liberté, Douala',
    latitude: 4.0483,
    longitude: 9.6995,
    state: 'VALIDATED',
    plannedInDays: -9,
    proofOffsetMeters: 18,
    proofBearing: 40,
    photo: 1,
  },
  {
    location: 'Bonapriso — Rue Njo-Njo, Douala',
    latitude: 4.0297,
    longitude: 9.6924,
    state: 'VALIDATED',
    plannedInDays: -8,
    proofOffsetMeters: 45,
    proofBearing: 210,
    photo: 2,
  },
  {
    location: 'Bonamoussadi — Carrefour Bonamoussadi, Douala',
    latitude: 4.0912,
    longitude: 9.7398,
    state: 'PENDING_REVIEW',
    plannedInDays: -3,
    proofOffsetMeters: 32,
    proofBearing: 120,
    photo: 3,
  },
  {
    location: 'Deido — Rond-point Deido, Douala',
    latitude: 4.0633,
    longitude: 9.7079,
    state: 'REJECTED',
    plannedInDays: -6,
    proofOffsetMeters: 150,
    proofBearing: 300,
    photo: 4,
    comment:
      'Affiche en partie masquée par un panneau voisin et photo prise trop loin du point prévu : merci de reprendre la photo de face, au pied du panneau.',
  },
  {
    location: 'Bastos — Avenue Rosa Parks, Yaoundé',
    latitude: 3.8895,
    longitude: 11.5135,
    state: 'VALIDATED',
    plannedInDays: -7,
    proofOffsetMeters: 9,
    proofBearing: 80,
    photo: 5,
  },
  {
    location: 'Mvan — Carrefour Mvan, Yaoundé',
    latitude: 3.8331,
    longitude: 11.5186,
    state: 'PENDING_REVIEW',
    plannedInDays: -1,
    proofOffsetMeters: 115,
    proofBearing: 160,
    photo: 6,
  },
  {
    location: 'Ndokoti — Carrefour Ndokoti, Douala',
    latitude: 4.0461,
    longitude: 9.7357,
    state: 'PLANNED',
    plannedInDays: 2,
  },
  {
    location: 'Mvog-Mbi — Marché Mvog-Mbi, Yaoundé',
    latitude: 3.8562,
    longitude: 11.5205,
    state: 'PLANNED',
    plannedInDays: 5,
  },
];
