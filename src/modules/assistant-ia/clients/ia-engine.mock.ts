import { Injectable } from '@nestjs/common';
import { IAEngineInterface } from './ia-engine.interface';
import type {
  AskPublicQuestionParams,
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

  async askPublicQuestion(
    params: AskPublicQuestionParams,
  ): Promise<AskQuestionResult> {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return {
      answer: `Mock public response to: "${params.userMessage}" (Mock IA)`,
    };
  }

  async *streamQuestion(params: AskQuestionParams): AsyncGenerator<string> {
    const { answer } = await this.askQuestion(params);
    yield* answer.split(/(?<=s)/);
  }

  async *streamPublicQuestion(
    params: AskPublicQuestionParams,
  ): AsyncGenerator<string> {
    const { answer } = await this.askPublicQuestion(params);
    yield* answer.split(/(?<=s)/);
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
