export const SIMULATION_ENGINE_TOKEN = 'SIMULATION_ENGINE_TOKEN';

export interface SimulationParameters {
  campaignName: string;
  objective: string;
  plannedBudget: number;
  answers: { questionId: string; value: string }[];
}

export interface SimulationResult {
  estimatedBudget: number;
  expectedResults: string;
}

export interface SimulationEngineInterface {
  simulate(params: SimulationParameters): Promise<SimulationResult>;
}
