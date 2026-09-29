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
    const name = params.campaign.name;
    return {
      recommendations: [
        {
          title: `Suivre les résultats de ${name}`,
          content: 'Recommandation de démonstration (Mock IA).',
          priority: 'high',
          category: 'measurement',
        },
        {
          title: "Resserrer l'audience",
          content: 'Recommandation de démonstration (Mock IA).',
          priority: 'medium',
          category: 'audience',
        },
        {
          title: 'Tester un second visuel',
          content: 'Recommandation de démonstration (Mock IA).',
          priority: 'low',
          category: 'creative',
        },
      ],
    };
  }
}
