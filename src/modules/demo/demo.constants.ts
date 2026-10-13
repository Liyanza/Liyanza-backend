import type { ConfigService } from '@nestjs/config';

/**
 * Domaine réservé aux comptes de la démo publique. Un sous-domaine sans
 * boîte mail : aucun e-mail envoyé à ces adresses ne peut arriver nulle
 * part, et aucun compte Google/Facebook réel ne peut le porter.
 */
export const DEMO_EMAIL_DOMAIN = 'demo.kiyanza.com';

/** Compte ADMIN de l'entreprise de démo, celui de chaque visiteur. */
export const DEMO_USER_EMAIL = `visiteur@${DEMO_EMAIL_DOMAIN}`;

export const DEMO_COMPANY = {
  name: 'Brasserie Sawa (démo)',
  businessSector: 'Boissons',
  address: 'Rue Joss, Bonanjo, Douala, Cameroun',
} as const;

/** Copilot : messages par jour UTC pour toute l'entreprise de démo. */
export const DEFAULT_DEMO_COPILOT_DAILY_MESSAGES = 30;

/**
 * Vrai si l'adresse appartient à un compte de démo. Sert aux parcours
 * publics (mot de passe oublié, connexion Google/Facebook, inscription) qui
 * n'ont pas de session à interroger : un compte de démo ne doit jamais
 * recevoir de mot de passe ni être lié à un compte externe.
 */
export function isDemoEmail(email: string | null | undefined): boolean {
  return (
    typeof email === 'string' &&
    email.trim().toLowerCase().endsWith(`@${DEMO_EMAIL_DOMAIN}`)
  );
}

/** `DEMO_ENABLED` absente ou différente de `'false'` : démo activée. */
export function isDemoEnabled(config: ConfigService): boolean {
  const value = config.get<string | boolean>('DEMO_ENABLED');
  return String(value ?? 'true').toLowerCase() !== 'false';
}

export function demoCopilotDailyMessages(config: ConfigService): number {
  const raw = config.get<number | string>('DEMO_COPILOT_DAILY_MESSAGES');
  // Variable laissée vide dans un `.env` : valeur par défaut, pas 0.
  const value = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : DEFAULT_DEMO_COPILOT_DAILY_MESSAGES;
}
