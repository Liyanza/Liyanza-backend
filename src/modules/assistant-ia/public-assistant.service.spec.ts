import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { RedisService } from '../redis/redis.service';
import { IAEngineInterface } from './clients/ia-engine.interface';
import { PublicAssistantService } from './public-assistant.service';

describe('PublicAssistantService', () => {
  const SECRET = 's'.repeat(64);

  let counters: Map<string, number>;
  let config: Record<string, unknown>;
  let iaEngine: jest.Mocked<IAEngineInterface>;
  let service: PublicAssistantService;

  beforeEach(() => {
    counters = new Map();
    config = { WEB_PROXY_SECRET: SECRET };

    // Compteurs Redis en mémoire, même contrat que `incrementWithTtl`.
    const redis = {
      incrementWithTtl: jest.fn((key: string, ttl: number) => {
        const value = (counters.get(key) ?? 0) + 1;
        counters.set(key, value);
        return Promise.resolve([value, ttl]);
      }),
    } as unknown as RedisService;
    const configService = {
      get: jest.fn((key: string) => config[key]),
    } as unknown as ConfigService;
    iaEngine = {
      askQuestion: jest.fn(),
      askPublicQuestion: jest.fn().mockResolvedValue({ answer: 'Bonjour !' }),
      streamQuestion: jest.fn(),
      streamPublicQuestion: jest.fn(),
      generateRecommendations: jest.fn(),
    };

    service = new PublicAssistantService(redis, configService, iaEngine);
  });

  const request = (headers: Record<string, string>, ip = '10.0.0.1') =>
    ({ headers, ip }) as unknown as Request;

  describe('resolveVisitorIp', () => {
    it('should trust X-Visitor-IP only with the right proxy secret', () => {
      expect(
        service.resolveVisitorIp(
          request({
            'x-web-proxy-secret': SECRET,
            'x-visitor-ip': '196.200.1.2',
          }),
        ),
      ).toBe('196.200.1.2');
    });

    it('should ignore X-Visitor-IP with a wrong or missing secret (spoofing)', () => {
      expect(
        service.resolveVisitorIp(
          request({ 'x-web-proxy-secret': 'nope', 'x-visitor-ip': '1.1.1.1' }),
        ),
      ).toBe('10.0.0.1');
      expect(
        service.resolveVisitorIp(request({ 'x-visitor-ip': '1.1.1.1' })),
      ).toBe('10.0.0.1');
    });

    it('should ignore a relayed value that is not an IP address', () => {
      expect(
        service.resolveVisitorIp(
          request({ 'x-web-proxy-secret': SECRET, 'x-visitor-ip': 'evil' }),
        ),
      ).toBe('10.0.0.1');
    });

    it('should fall back to req.ip when WEB_PROXY_SECRET is not configured', () => {
      config.WEB_PROXY_SECRET = undefined;
      expect(
        service.resolveVisitorIp(
          request({ 'x-web-proxy-secret': '', 'x-visitor-ip': '1.1.1.1' }),
        ),
      ).toBe('10.0.0.1');
    });
  });

  describe('ask', () => {
    it('should forward the question and the (truncated) history in public mode', async () => {
      const result = await service.ask(
        {
          message: 'Que fait Kiyanza ?',
          history: [{ sender: 'USER', content: 'x'.repeat(2000) }],
        },
        '196.200.1.2',
      );

      expect(result).toEqual({ answer: 'Bonjour !' });
      const [params] = iaEngine.askPublicQuestion.mock.calls[0];
      expect(params.userMessage).toBe('Que fait Kiyanza ?');
      expect(params.recentMessages?.[0].content).toHaveLength(1500);
    });

    it('should never store the raw IP in Redis keys', async () => {
      await service.ask({ message: 'Bonjour' }, '196.200.1.2');
      expect([...counters.keys()].join()).not.toContain('196.200.1.2');
    });

    it('should allow 3 questions per minute per visitor, then 429', async () => {
      for (let i = 0; i < 3; i++) {
        await service.ask({ message: 'Q' }, '196.200.1.2');
      }
      await expect(
        service.ask({ message: 'Q' }, '196.200.1.2'),
      ).rejects.toMatchObject({ status: 429 });
      // Un autre visiteur n'est pas affecté.
      await expect(
        service.ask({ message: 'Q' }, '196.200.9.9'),
      ).resolves.toEqual({ answer: 'Bonjour !' });
    });

    it('should cap each visitor at 10 questions per day', async () => {
      for (let i = 0; i < 10; i++) {
        await service.ask({ message: 'Q' }, '196.200.1.2');
        // Fenêtre « minute » écoulée entre deux questions.
        for (const key of counters.keys()) {
          if (key.endsWith(':minute')) counters.set(key, 0);
        }
      }

      const error: unknown = await service
        .ask({ message: 'Q' }, '196.200.1.2')
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(429);
    });

    it('should stop everyone once the global daily limit is reached (503)', async () => {
      config.PUBLIC_ASSISTANT_DAILY_LIMIT = 2;
      await service.ask({ message: 'Q' }, '1.1.1.1');
      await service.ask({ message: 'Q' }, '2.2.2.2');

      await expect(
        service.ask({ message: 'Q' }, '3.3.3.3'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('should not call the IA when a quota is exceeded', async () => {
      config.PUBLIC_ASSISTANT_DAILY_LIMIT = 0;
      await expect(
        service.ask({ message: 'Q' }, '1.1.1.1'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(iaEngine.askPublicQuestion).not.toHaveBeenCalled();
    });

    it('should answer 503 when the IA service fails', async () => {
      iaEngine.askPublicQuestion.mockRejectedValue(new Error('down'));
      await expect(
        service.ask({ message: 'Q' }, '1.1.1.1'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });

  describe('askStream', () => {
    async function* stream(parts: string[], failWith?: Error) {
      for (const part of parts) {
        await Promise.resolve();
        yield part;
      }
      if (failWith) throw failWith;
    }

    it('should relay the chunks then emit "done"', async () => {
      iaEngine.streamPublicQuestion.mockReturnValue(stream(['Bien', 'venue']));
      const emit = jest.fn();

      await service.askStream({ message: 'Bonjour' }, '1.1.1.1', emit);

      expect(emit.mock.calls.map(([event]: [unknown]) => event)).toEqual([
        { type: 'delta', text: 'Bien' },
        { type: 'delta', text: 'venue' },
        { type: 'done' },
      ]);
    });

    it('should apply the quotas BEFORE opening the stream (plain 429)', async () => {
      const emit = jest.fn();
      for (let i = 0; i < 3; i++) {
        iaEngine.streamPublicQuestion.mockReturnValue(stream(['ok']));
        await service.askStream({ message: 'Q' }, '1.1.1.1', emit);
      }
      emit.mockClear();
      iaEngine.streamPublicQuestion.mockClear();

      const error: unknown = await service
        .askStream({ message: 'Q' }, '1.1.1.1', emit)
        .catch((e: unknown) => e);
      expect((error as HttpException).getStatus()).toBe(429);
      expect(emit).not.toHaveBeenCalled();
      expect(iaEngine.streamPublicQuestion).not.toHaveBeenCalled();
    });

    it('should answer 503 when the IA fails before the first chunk', async () => {
      iaEngine.streamPublicQuestion.mockReturnValue(
        stream([], new Error('down')),
      );
      const emit = jest.fn();

      await expect(
        service.askStream({ message: 'Q' }, '1.1.1.1', emit),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(emit).not.toHaveBeenCalled();
    });
  });
});
