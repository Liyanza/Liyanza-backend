export const IA_ENGINE_TOKEN = 'IA_ENGINE_TOKEN';

export interface AskQuestionParams {
  conversationId: string;
  userMessage: string;
  context?: Record<string, any>;
}

export interface AskQuestionResult {
  answer: string;
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

export interface IAEngineInterface {
  askQuestion(params: AskQuestionParams): Promise<AskQuestionResult>;
  generateRecommendations(
    params: GenerateRecommendationsParams,
  ): Promise<GenerateRecommendationsResult>;
}
