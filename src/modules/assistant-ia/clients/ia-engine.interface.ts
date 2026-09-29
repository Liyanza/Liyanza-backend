export const IA_ENGINE_TOKEN = 'IA_ENGINE_TOKEN';

/**
 * Contexte transmis au service chatbot (`kiyanza_assistant_ia`, modèle
 * Pydantic `AskContext` de `chatbot_api.py`). Tout est facultatif, et
 * appartient TOUJOURS à l'entreprise de l'utilisateur courant : l'isolation
 * multi-tenant est garantie ici, jamais côté Python.
 */
export interface AskQuestionContext {
  topic?: string;
  companyProfile?: {
    name: string;
    businessSector: string;
    address: string;
  };
  /**
   * Campagne affichée à l'écran quand la question est posée depuis le
   * Copilot (modèle Pydantic `CampaignContext`). Chargée par le backend,
   * toujours dans le périmètre de l'entreprise de l'utilisateur.
   */
  campaign?: CampaignContext;
  /** Fenêtre bornée, du plus ancien au plus récent (20 max côté Python). */
  recentMessages?: ChatHistoryMessage[];
}

export interface ChatHistoryMessage {
  sender: 'USER' | 'AI';
  content: string;
}

export interface CampaignContext {
  name: string;
  objective: string;
  status: string;
  plannedBudget: number;
  /** Dates au format AAAA-MM-JJ. */
  startDate: string;
  endDate: string;
  /** Ex: "Radio", "Affichage", "FACEBOOK". */
  channels: string[];
  /** Dernière valeur connue de chaque indicateur (`Statistic`). */
  results: Record<string, number>;
}

export interface AskQuestionParams {
  conversationId: string;
  userMessage: string;
  context?: AskQuestionContext;
}

export interface AskQuestionResult {
  answer: string;
}

/**
 * Question d'un visiteur anonyme du site vitrine (mode `public` du service
 * chatbot : prompt de présentation, aucune donnée, aucun SQL). L'historique
 * vient du navigateur du visiteur : 4 messages au plus.
 */
export interface AskPublicQuestionParams {
  userMessage: string;
  recentMessages?: ChatHistoryMessage[];
}

/**
 * Tout ce que le backend sait d'une campagne, envoyé au service chatbot
 * (`POST /campaign/recommendations`, modèle Pydantic
 * `CampaignRecommendationsRequest`). Chargé dans le périmètre de
 * l'entreprise de l'utilisateur ; un bloc absent = pas de donnée.
 */
export interface GenerateRecommendationsParams {
  /** Date du jour, AAAA-MM-JJ. */
  today: string;
  campaign: {
    name: string;
    type: 'DIGITAL' | 'RADIO' | 'POSTER';
    objective: string;
    status: string;
    plannedBudget: number;
    actualBudget?: number;
    startDate: string;
    endDate: string;
  };
  company?: { name: string; businessSector: string; address: string };
  digital?: {
    objective: string;
    customObjective?: string;
    ageMin: number;
    ageMax: number;
    gender: string;
    locations: string[];
    interests: string[];
    budgetAllocation: string;
    channels: string[];
    linkedToFacebookAds: boolean;
  };
  /** Dernière simulation (scénario recommandé). */
  simulation?: {
    simulatedAt: string;
    predictedReach?: number;
    predictedCtr?: number;
    predictedEngagementRate?: number;
    avgCpc?: number;
    costPerAcquisition?: number;
    conversionRate?: number;
    recommendedStrategy?: string;
    warnings: string[];
    aiSummary?: string;
  };
  /** Résultats réels Facebook Ads, totaux depuis le lancement. */
  actual?: {
    spendXaf: number;
    impressions: number;
    reach: number;
    clicks: number;
    conversions: number;
    collectedAt: string;
  };
  /** Alertes ouvertes (non résolues). */
  alerts: Array<{
    type: string;
    severity: string;
    data: Record<string, unknown>;
  }>;
  radio?: {
    planned: number;
    broadcasted: number;
    missed: number;
    cancelled: number;
    /** Diffusions prévues pas encore passées. */
    upcoming: number;
  };
  field?: {
    installations: number;
    byStatus: Record<string, number>;
    proofsValidated: number;
    proofsPending: number;
    proofsRejected: number;
  };
  /** Dernière valeur connue de chaque indicateur (`Statistic`). */
  statistics: Record<string, number>;
  /** Titres (ou textes) des recommandations déjà données, à ne pas répéter. */
  previousRecommendations: string[];
}

export type RecommendationPriority = 'high' | 'medium' | 'low';

export interface GenerateRecommendationsResult {
  recommendations: Array<{
    /** L'action, en quelques mots. */
    title?: string;
    /** Le détail : quoi faire et pourquoi. */
    content: string;
    priority: RecommendationPriority;
    /** budget, audience, creative, channel, timing, field, radio, measurement. */
    category?: string;
  }>;
}

// NOTE: methods are declared as function-typed *properties* (arrow style)
// rather than method signatures on purpose. TypeScript treats method
// signatures as capable of a polymorphic `this`, which is what triggers
// @typescript-eslint/unbound-method false positives on
// `expect(iaEngine.askQuestion).toHaveBeenCalledWith(...)` in tests, even
// once the object is wrapped by jest.Mocked<...>. Function-typed properties
// don't have that `this` ambiguity, so the rule no longer fires — with no
// runtime difference and no eslint config changes needed.
export interface IAEngineInterface {
  askQuestion: (params: AskQuestionParams) => Promise<AskQuestionResult>;
  askPublicQuestion: (
    params: AskPublicQuestionParams,
  ) => Promise<AskQuestionResult>;
  /**
   * Mêmes questions, réponse morceau par morceau au fil de sa génération
   * (`POST /ask/stream` du service chatbot). Une erreur avant le premier
   * morceau est levée au premier `next()` ; une interruption ensuite lève
   * une erreur en cours d'itération.
   */
  streamQuestion: (params: AskQuestionParams) => AsyncIterable<string>;
  streamPublicQuestion: (
    params: AskPublicQuestionParams,
  ) => AsyncIterable<string>;
  generateRecommendations: (
    params: GenerateRecommendationsParams,
  ) => Promise<GenerateRecommendationsResult>;
}
