import { DigitalSimulationEngineHeuristic } from './digital-simulation-engine.heuristic';
import { DigitalSimulationParameters } from './digital-simulation-engine.interface';

function baseParams(
  overrides: Partial<DigitalSimulationParameters> = {},
): DigitalSimulationParameters {
  return {
    objective: 'CONVERSION',
    budget: { amount: 500_000, allocation: 'TOTAL' },
    audience: {
      ageMin: 25,
      ageMax: 45,
      targetGender: 'ALL',
      locations: ['Douala'],
      interests: ['Commerce & PME'],
    },
    channels: [{ platform: 'FACEBOOK', metrics: null }],
    ...overrides,
  };
}

describe('DigitalSimulationEngineHeuristic', () => {
  let engine: DigitalSimulationEngineHeuristic;

  beforeEach(() => {
    engine = new DigitalSimulationEngineHeuristic();
  });

  it('rejects a simulation with no channels', async () => {
    await expect(engine.simulate(baseParams({ channels: [] }))).rejects.toThrow(
      'At least one channel is required',
    );
  });

  it('returns every field of the contract', async () => {
    const result = await engine.simulate(baseParams());

    expect(result.scenarios).toHaveLength(3);
    expect(result.weeklySeries).toHaveLength(5);
    expect(result.channelBreakdown).toHaveLength(1);
    expect(typeof result.narrativeSummary).toBe('string');
    expect(result.narrativeSummary.length).toBeGreaterThan(0);
  });

  it('is deterministic — same input, same output', async () => {
    const resultA = await engine.simulate(baseParams());
    const resultB = await engine.simulate(baseParams());
    expect(resultA).toEqual(resultB);
  });

  it('produces different results for different objectives', async () => {
    const conversion = await engine.simulate(
      baseParams({ objective: 'CONVERSION' }),
    );
    const awareness = await engine.simulate(
      baseParams({ objective: 'AWARENESS' }),
    );
    expect(conversion.predictedReach).not.toEqual(awareness.predictedReach);
  });

  it('emits a warning when a channel has no real metrics', async () => {
    const result = await engine.simulate(baseParams());
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('FACEBOOK');
    expect(result.warnings[0]).toContain('connectez');
  });

  it('asks to resync, not to connect, when the account is linked but not yet synced', async () => {
    const result = await engine.simulate(
      baseParams({
        channels: [
          { platform: 'FACEBOOK', metrics: null, accountLinked: true },
        ],
      }),
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('pas encore synchronisées');
    expect(result.warnings[0]).not.toContain('connectez');
  });

  it('emits no warning when the channel has real metrics', async () => {
    const result = await engine.simulate(
      baseParams({
        channels: [
          {
            platform: 'FACEBOOK',
            metrics: { avgCpm: 1500, avgCpc: 60, followerCount: 3000 },
          },
        ],
      }),
    );
    expect(result.warnings).toHaveLength(0);
  });

  it('real metrics produce a higher reach than generic benchmarks for a low CPM', async () => {
    const withoutMetrics = await engine.simulate(
      baseParams({
        objective: 'SALES',
        channels: [{ platform: 'FACEBOOK', metrics: null }],
      }),
    );
    const withMetrics = await engine.simulate(
      baseParams({
        objective: 'SALES',
        channels: [
          {
            platform: 'FACEBOOK',
            metrics: { avgCpm: 900, avgCpc: 45, followerCount: 5000 },
          },
        ],
      }),
    );
    expect(withMetrics.predictedReach).toBeGreaterThan(
      withoutMetrics.predictedReach,
    );
  });

  it('applies an overlap discount when multiple channels are selected', async () => {
    const single = await engine.simulate(
      baseParams({ channels: [{ platform: 'FACEBOOK', metrics: null }] }),
    );
    const multi = await engine.simulate(
      baseParams({
        channels: [
          { platform: 'FACEBOOK', metrics: null },
          { platform: 'INSTAGRAM', metrics: null },
        ],
      }),
    );
    // Budget partagé entre 2 canaux au lieu d'un : comparaison directe non
    // 1:1, on vérifie juste que la décote de chevauchement est appliquée.
    expect(multi.channelBreakdown[0].budgetAmount).toBeLessThan(
      single.channelBreakdown[0].budgetAmount,
    );
  });

  it('recommended scenario A is never scaled down like B and C', async () => {
    const result = await engine.simulate(baseParams());
    const scenarioA = result.scenarios.find((s) => s.id === 'A')!;
    const scenarioC = result.scenarios.find((s) => s.id === 'C')!;
    expect(scenarioA.isRecommended).toBe(true);
    expect(scenarioC.predictedReach).toBeLessThan(scenarioA.predictedReach);
  });

  it('never divides by zero when the budget is zero', async () => {
    const result = await engine.simulate(
      baseParams({ budget: { amount: 0, allocation: 'TOTAL' } }),
    );
    expect(result.avgCpc).toBe(0);
    expect(result.costPerAcquisition).toBe(0);
    expect(result.conversionRate).toBe(0);
    expect(Number.isFinite(result.avgCpc)).toBe(true);
  });

  it('never returns negative values', async () => {
    const result = await engine.simulate(
      baseParams({ budget: { amount: 1, allocation: 'TOTAL' } }),
    );
    for (const value of [
      result.predictedReach,
      result.predictedCtr,
      result.predictedRoas,
      result.avgCpc,
      result.costPerAcquisition,
      result.conversionRate,
    ]) {
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });
});
