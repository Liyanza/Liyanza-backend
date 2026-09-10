import { SocialPlatform } from '@prisma/client';

export const SOCIAL_PLATFORM_CLIENT_TOKEN = 'SOCIAL_PLATFORM_CLIENT_TOKEN';

/**
 * Contrat vers l'API Graph de Meta (BACK-502/503). Ce n'est PAS une frontière
 * IA : il s'agit d'une API de données sociales, pas d'un LLM — voir
 * `.claude/skills/liyanza-ia-boundary/SKILL.md`. L'implémentation
 * (`MetaGraphClient`) sera réelle, jamais mockée en production.
 *
 * Interface committée en Étape 1 (architecture) ; câblée dans
 * `SocialAccountsModule` en Étape 2 (OAuth réel + ingestion de métriques).
 */
export interface ExchangedToken {
  accessToken: string;
  expiresInSeconds: number | null;
  scopes: string[];
}

export interface SocialAccountProfile {
  externalAccountId: string;
  externalAccountName: string | null;
  /**
   * Un compte Facebook/Instagram géré via ce produit est en réalité une
   * PAGE Facebook (Instagram s'y rattache via son compte professionnel lié).
   * Les appels Graph API sur une Page/un compte Instagram professionnel
   * s'authentifient avec le token de LA PAGE, pas le token utilisateur
   * obtenu à l'échange initial — présent ici quand c'est le cas, le service
   * appelant doit alors chiffrer/stocker CE token plutôt que celui de
   * `exchangeCodeForLongLivedToken`.
   */
  accessTokenOverride?: string;
}

export interface PlatformInsights {
  followerCount?: number;
  impressions?: number;
  reach?: number;
  engagementRate?: number;
  /**
   * CPM/CPC historiques : nécessitent la découverte d'un compte publicitaire
   * (`/me/adaccounts`, permission `ads_read`) à partir du token UTILISATEUR
   * — non implémenté en V1 pour ne pas avoir à conserver ce token en plus du
   * token de Page réellement utilisé au quotidien (surface de sécurité
   * réduite). Toujours `undefined` avec l'implémentation actuelle
   * (`MetaGraphClient`) — dégradation déjà gérée par
   * `DigitalSimulationEngineMock`/`DigitalCampaignsService`.
   */
  avgCpm?: number;
  avgCpc?: number;
  raw: unknown;
}

export interface SocialPlatformClientInterface {
  /** Échange un `code` OAuth contre un token court, puis long-lived. */
  exchangeCodeForLongLivedToken(
    platform: SocialPlatform,
    code: string,
    redirectUri: string,
  ): Promise<ExchangedToken>;

  getAccountProfile(
    platform: SocialPlatform,
    accessToken: string,
  ): Promise<SocialAccountProfile>;

  getInsights(
    platform: SocialPlatform,
    accessToken: string,
    externalAccountId: string,
  ): Promise<PlatformInsights>;
}
