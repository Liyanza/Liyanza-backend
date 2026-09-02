import { Injectable } from '@nestjs/common';
import { IAEngineInterface } from './ia-engine.interface';
import type {
  AskQuestionParams,
  AskQuestionResult,
  GenerateRecommendationsParams,
  GenerateRecommendationsResult,
} from './ia-engine.interface';

@Injectable()
export class IAEngineMock implements IAEngineInterface {
  async askQuestion(params: AskQuestionParams): Promise<AskQuestionResult> {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return {
      answer: `Mock response to: "${params.userMessage}" (Mock IA)`,
    };
  }

  async generateRecommendations(
    params: GenerateRecommendationsParams,
  ): Promise<GenerateRecommendationsResult> {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return {
      recommendations: [
        {
          content: `Recommendation 1 for ${params.campaignName}: increase radio budget.`,
          priority: 'high',
        },
        {
          content: `Recommendation 2: target 18-25 age group.`,
          priority: 'medium',
        },
        {
          content: `Recommendation 3: add more visuals.`,
          priority: 'low',
        },
      ],
    };
  }
}
