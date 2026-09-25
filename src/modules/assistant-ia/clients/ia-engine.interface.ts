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

export interface GenerateRecommendationsParams {
  campaignId: string;
  campaignName: string;
  objective: string;
  plannedBudget: number;
}

export interface GenerateRecommendationsResult {
  recommendations: Array<{
    content: string;
    priority: string; // ex: "high", "medium", "low"
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
