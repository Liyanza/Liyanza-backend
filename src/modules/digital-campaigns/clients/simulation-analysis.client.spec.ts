import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { AxiosError, AxiosHeaders } from 'axios';
import { of, throwError } from 'rxjs';
import {
  SimulationAnalysisClient,
  type SimulationAnalysisInput,
} from './simulation-analysis.client';

describe('SimulationAnalysisClient', () => {
  const post = jest.fn();
  const http = { post } as unknown as HttpService;

  const configWith = (values: Record<string, unknown>) =>
    ({
      get: jest.fn((key: string) => values[key]),
      getOrThrow: jest.fn((key: string) => {
        if (values[key] === undefined) throw new Error(`Missing ${key}`);
        return values[key];
      }),
    }) as unknown as ConfigService;

  const configured = configWith({
    IA_SERVICE_URL: 'https://ia.example.com/',
    IA_SERVICE_INTERNAL_TOKEN: 't'.repeat(64),
  });

  const input: SimulationAnalysisInput = {
    objective: 'CONVERSION',
    budget: { amount: 250000 },
    audience: { locations: ['Douala'], interests: [] },
    channels: ['FACEBOOK'],
    results: { predictedReach: 61200, warnings: [] },
    scenarios: [],
    channelBreakdown: [],
  };

  const analysis = {
    summary: 'Résumé',
    strengths: [],
    risks: [],
    recommendations: [],
    scenarioChoice: '',
  };

  beforeEach(() => post.mockReset());

  it('should do nothing (null, no network call) when the IA service is not configured', async () => {
    const client = new SimulationAnalysisClient(http, configWith({}));

    await expect(client.analyze(input)).resolves.toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it('should POST the simulation with the internal token and return the analysis', async () => {
    post.mockReturnValue(of({ data: analysis }));
    const client = new SimulationAnalysisClient(http, configured);

    await expect(client.analyze(input)).resolves.toEqual(analysis);
    expect(post).toHaveBeenCalledWith(
      'https://ia.example.com/simulation/analyze',
      input,
      {
        headers: expect.objectContaining({
          'X-Internal-Token': 't'.repeat(64),
        }) as Record<string, string>,
      },
    );
  });

  it('should throw on an HTTP error or an empty analysis', async () => {
    const client = new SimulationAnalysisClient(http, configured);

    post.mockReturnValueOnce(
      throwError(
        () =>
          new AxiosError(
            'Service Unavailable',
            '503',
            { headers: new AxiosHeaders() },
            {},
            {
              status: 503,
              statusText: 'Service Unavailable',
              data: {},
              headers: {},
              config: { headers: new AxiosHeaders() },
            },
          ),
      ),
    );
    await expect(client.analyze(input)).rejects.toThrow(
      'IA service responded 503',
    );

    post.mockReturnValueOnce(of({ data: { summary: '' } }));
    await expect(client.analyze(input)).rejects.toThrow(
      'IA service returned no analysis',
    );
  });
});
