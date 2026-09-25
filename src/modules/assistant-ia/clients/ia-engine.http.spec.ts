import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { AxiosError, AxiosHeaders } from 'axios';
import { of, throwError } from 'rxjs';
import { IAEngineHttpClient } from './ia-engine.http';

describe('IAEngineHttpClient', () => {
  const post = jest.fn();
  const http = { post } as unknown as HttpService;

  const values: Record<string, unknown> = {
    IA_SERVICE_URL: 'https://ia.example.com/',
    IA_SERVICE_INTERNAL_TOKEN: 'a'.repeat(64),
  };
  const configService = {
    getOrThrow: jest.fn((key: string) => {
      const value = values[key];
      if (value === undefined) throw new Error(`Missing ${key}`);
      return value;
    }),
  } as unknown as ConfigService;

  const params = {
    conversationId: 'conv-1',
    userMessage: 'Quel réseau social choisir ?',
    context: { topic: 'Canaux' },
  };

  beforeEach(() => {
    post.mockReset();
  });

  it('should POST the question to /ask with the internal token and return the answer', async () => {
    post.mockReturnValue(of({ data: { answer: 'Facebook et WhatsApp.' } }));
    const client = new IAEngineHttpClient(http, configService);

    await expect(client.askQuestion(params)).resolves.toEqual({
      answer: 'Facebook et WhatsApp.',
    });
    // Slash final de IA_SERVICE_URL retiré : pas de "//ask".
    expect(post).toHaveBeenCalledWith('https://ia.example.com/ask', params, {
      headers: expect.objectContaining({
        'X-Internal-Token': 'a'.repeat(64),
      }) as Record<string, string>,
    });
  });

  it('should send public questions in "public" mode with only the history as context', async () => {
    post.mockReturnValue(of({ data: { answer: 'Bienvenue sur Kiyanza.' } }));
    const client = new IAEngineHttpClient(http, configService);
    const recentMessages = [{ sender: 'USER' as const, content: 'Bonjour' }];

    await expect(
      client.askPublicQuestion({ userMessage: 'Tarifs ?', recentMessages }),
    ).resolves.toEqual({ answer: 'Bienvenue sur Kiyanza.' });
    expect(post).toHaveBeenCalledWith(
      'https://ia.example.com/ask',
      {
        mode: 'public',
        userMessage: 'Tarifs ?',
        context: { recentMessages },
      },
      expect.anything(),
    );
  });

  it('should reject when the service answers without text', async () => {
    post.mockReturnValue(of({ data: {} }));
    const client = new IAEngineHttpClient(http, configService);

    await expect(client.askQuestion(params)).rejects.toThrow(
      'IA service returned no answer',
    );
  });

  it('should surface the HTTP status on failure, never the response body', async () => {
    const axiosError = new AxiosError(
      'Request failed with status code 401',
      '401',
      { headers: new AxiosHeaders() },
      {},
      {
        status: 401,
        statusText: 'Unauthorized',
        data: { detail: 'Unauthorized' },
        headers: {},
        config: { headers: new AxiosHeaders() },
      },
    );
    post.mockReturnValue(throwError(() => axiosError));
    const client = new IAEngineHttpClient(http, configService);

    await expect(client.askQuestion(params)).rejects.toThrow(
      'IA service responded 401',
    );
  });

  it('should report an unreachable service (timeout, DNS, instance stopped)', async () => {
    post.mockReturnValue(
      throwError(() => new AxiosError('timeout exceeded', 'ECONNABORTED')),
    );
    const client = new IAEngineHttpClient(http, configService);

    await expect(client.askQuestion(params)).rejects.toThrow(
      'IA service unreachable (ECONNABORTED)',
    );
  });

  it('should keep generating recommendations locally (no chatbot endpoint for them yet)', async () => {
    const client = new IAEngineHttpClient(http, configService);

    const result = await client.generateRecommendations({
      campaignId: 'camp-1',
      campaignName: 'Test',
      objective: 'Reach',
      plannedBudget: 1000,
    });

    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(post).not.toHaveBeenCalled();
  });
});
