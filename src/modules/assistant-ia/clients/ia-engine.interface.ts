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
  generateRecommendations: (
    params: GenerateRecommendationsParams,
  ) => Promise<GenerateRecommendationsResult>;
}
