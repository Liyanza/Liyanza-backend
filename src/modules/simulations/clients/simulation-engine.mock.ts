import { Injectable } from '@nestjs/common';
import {
  SimulationEngineInterface,
  SimulationParameters,
  SimulationResult,
} from './simulation-engine.interface';

@Injectable()
export class SimulationEngineMock implements SimulationEngineInterface {
  async simulate(params: SimulationParameters): Promise<SimulationResult> {
    await new Promise((resolve) => setTimeout(resolve, 500));

    const baseBudget = params.plannedBudget;
    const estimatedBudget = baseBudget * (0.8 + Math.random() * 0.4);
    const expectedResults = `Projected reach: ${Math.floor(1000 + Math.random() * 5000)} people. Engagement rate: ${(Math.random() * 5 + 1).toFixed(1)}%.`;

    return {
      estimatedBudget: Math.round(estimatedBudget * 100) / 100,
      expectedResults,
    };
  }
}
