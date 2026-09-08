import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { RedisService } from './redis.service';

const mockRedisClient = {
  set: jest.fn(),
  get: jest.fn(),
  del: jest.fn(),
  getdel: jest.fn(),
  exists: jest.fn(),
  ttl: jest.fn(),
  scan: jest.fn(),
  multi: jest.fn(),
  quit: jest.fn(),
  // CORRECTIF AUDIT : le service enregistre désormais un écouteur `error`
  // (sans lui, un incident réseau Redis terminait le processus Node).
  on: jest.fn(),
};

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => mockRedisClient);
});

describe('RedisService', () => {
  let service: RedisService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RedisService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue('redis://localhost:6379'),
          },
        },
      ],
    }).compile();

    service = module.get<RedisService>(RedisService);
  });

  it('should register an error listener to avoid crashing the process', () => {
    expect(mockRedisClient.on).toHaveBeenCalledWith(
      'error',
      expect.any(Function),
    );
  });

  it('should set a value with TTL when provided', async () => {
    await service.set('key', 'value', 60);
    expect(mockRedisClient.set).toHaveBeenCalledWith('key', 'value', 'EX', 60);
  });

  it('should set a value without TTL when omitted', async () => {
    await service.set('key', 'value');
    expect(mockRedisClient.set).toHaveBeenCalledWith('key', 'value');
  });

  // CORRECTIF AUDIT : un TTL nul ou négatif était auparavant traité comme
  // « pas de TTL », créant une clé PERMANENTE — fuite mémoire Redis
  // silencieuse sur des données de session censées expirer.
  it.each([0, -1])('should reject a non-positive TTL (%s)', async (ttl) => {
    await expect(service.set('key', 'value', ttl)).rejects.toThrow();
    expect(mockRedisClient.set).not.toHaveBeenCalled();
  });

  describe('delByPattern', () => {
    it('should iterate with SCAN (never KEYS) and delete every match', async () => {
      mockRedisClient.scan
        .mockResolvedValueOnce(['12', ['refresh:u1:a', 'refresh:u1:b']])
        .mockResolvedValueOnce(['0', ['refresh:u1:c']]);
      mockRedisClient.del.mockResolvedValue(2).mockResolvedValue(1);

      await service.delByPattern('refresh:u1:*');

      expect(mockRedisClient.scan).toHaveBeenCalledTimes(2);
      expect(mockRedisClient.del).toHaveBeenCalledWith(
        'refresh:u1:a',
        'refresh:u1:b',
      );
      expect(mockRedisClient.del).toHaveBeenCalledWith('refresh:u1:c');
    });
  });

  describe('getDel', () => {
    it('should delegate to the atomic GETDEL command', async () => {
      // CORRECTIF : nécessaire pour un "single-use" sans race condition
      // (voir PrestationsService.consumeValidationLink). Un get()+del()
      // séparés laisseraient une fenêtre de rejeu concurrent.
      mockRedisClient.getdel.mockResolvedValue('unused');
      const result = await service.getDel('validation-link:jti-1');
      expect(mockRedisClient.getdel).toHaveBeenCalledWith(
        'validation-link:jti-1',
      );
      expect(result).toBe('unused');
    });

    it('should return null when the key does not exist (already consumed)', async () => {
      mockRedisClient.getdel.mockResolvedValue(null);
      const result = await service.getDel('validation-link:jti-1');
      expect(result).toBeNull();
    });
  });
});
