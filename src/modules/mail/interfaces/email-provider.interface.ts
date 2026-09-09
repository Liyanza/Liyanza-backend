/**
 * Contrat d'envoi d'email, découplé du transport concret (BACK-302). Permet
 * de substituer l'implémentation SMTP par un autre provider (ou un mock en
 * test) sans toucher aux appelants (`NotificationsProcessor`).
 */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<void>;
}

export const EMAIL_PROVIDER_TOKEN = 'EMAIL_PROVIDER_TOKEN';
