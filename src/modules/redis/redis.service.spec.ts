import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { RedisService } from './redis.service';

const mockRedisClient = {
  set: jest.fn(),
  get: jest.fn(),
  del: jest.fn(),
  getdel: jest.fn(),
  exists: jest.fn(),
  quit: jest.fn(),
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

  it('should set a value with TTL when provided', async () => {
    await service.set('key', 'value', 60);
    expect(mockRedisClient.set).toHaveBeenCalledWith('key', 'value', 'EX', 60);
  });

  it('should set a value without TTL when omitted', async () => {
    await service.set('key', 'value');
    expect(mockRedisClient.set).toHaveBeenCalledWith('key', 'value');
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
