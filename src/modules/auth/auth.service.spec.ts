/* eslint-disable @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { Role } from '@prisma/client';

type MockedPrisma = {
  user: {
    findUnique: jest.Mock;
  };
};

describe('AuthService', () => {
  let service: AuthService;
  let prisma: MockedPrisma;
  let jwtService: jest.Mocked<JwtService>;
  let redisService: jest.Mocked<RedisService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: PrismaService,
          useValue: {
            user: {
              findUnique: jest.fn(),
            },
          },
        },
        {
          provide: JwtService,
          useValue: {
            sign: jest.fn(),
            verify: jest.fn(),
            decode: jest.fn(),
          },
        },
        {
          provide: RedisService,
          useValue: {
            set: jest.fn(),
            get: jest.fn(),
            del: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    prisma = module.get(PrismaService);
    jwtService = module.get(JwtService);
    redisService = module.get(RedisService);
  });

  describe('register', () => {
    const dto = {
      email: 'new@test.com',
      password: 'SuperSecret1',
      firstName: 'New',
      lastName: 'User',
      phone: '+237600000000',
    };

    it('should create the user with a forced COMMUNITY_MANAGER role and no company, regardless of the payload', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      const createSpy = jest.fn().mockResolvedValue({
        id: 'user-1',
        ...dto,
        password: 'hashed',
        role: Role.COMMUNITY_MANAGER,
        companyId: null,
      });
      (prisma as unknown as { user: { create: jest.Mock } }).user.create =
        createSpy;

      // Regression test for the critical fix: even if an attacker smuggles
      // `role`/`companyId` fields onto the DTO object at runtime (bypassing
      // TypeScript typing, e.g. via a raw HTTP call), AuthService must never
      // read them.
      const maliciousDto = {
        ...dto,
        role: Role.ADMIN,
        companyId: 'victim-company-id',
      } as typeof dto;

      await service.register(maliciousDto);

      expect(createSpy).toHaveBeenCalledWith({
        data: expect.objectContaining({
          role: Role.COMMUNITY_MANAGER,
          companyId: null,
        }) as unknown,
      });
    });

    it('should throw ConflictException if the email is already used', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'existing' });
      await expect(service.register(dto)).rejects.toThrow(ConflictException);
    });

    it('should never return the password hash', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      (prisma as unknown as { user: { create: jest.Mock } }).user.create = jest
        .fn()
        .mockResolvedValue({
          id: 'user-1',
          ...dto,
          password: 'hashed-secret',
          role: Role.COMMUNITY_MANAGER,
          companyId: null,
        });

      const result = await service.register(dto);
      expect(result).not.toHaveProperty('password');
    });
  });

  describe('login', () => {
    const loginDto = { email: 'user@test.com', password: 'SuperSecret1' };

    it('should throw UnauthorizedException if user does not exist', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.login(loginDto)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should throw UnauthorizedException if user is deactivated', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        password: await bcrypt.hash(loginDto.password, 10),
        deactivatedAt: new Date(),
      });
      await expect(service.login(loginDto)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should throw UnauthorizedException on invalid password', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        password: await bcrypt.hash('OtherPassword1', 10),
        deactivatedAt: null,
      });
      await expect(service.login(loginDto)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should return tokens and store the refresh token in redis on success', async () => {
      const hashed = await bcrypt.hash(loginDto.password, 10);
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        email: loginDto.email,
        password: hashed,
        firstName: 'A',
        lastName: 'B',
        role: Role.ADMIN,
        companyId: 'c1',
        deactivatedAt: null,
      });
      jwtService.sign.mockReturnValueOnce('access-token');
      jwtService.sign.mockReturnValueOnce('refresh-token');
      jwtService.decode.mockReturnValue({
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      const result = await service.login(loginDto);

      expect(result.accessToken).toBe('access-token');
      expect(result.refreshToken).toBe('refresh-token');
      expect(redisService.set).toHaveBeenCalledWith(
        'refresh:u1',
        'refresh-token',
        expect.any(Number),
      );
    });
  });

  describe('refresh', () => {
    it('should throw UnauthorizedException if the token is invalid/expired', async () => {
      jwtService.verify.mockImplementation(() => {
        throw new Error('invalid');
      });
      await expect(service.refresh('bad-token')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should throw UnauthorizedException if stored token does not match', async () => {
      jwtService.verify.mockReturnValue({ sub: 'u1', role: Role.ADMIN });
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        deactivatedAt: null,
      });
      redisService.get.mockResolvedValue('another-token');

      await expect(service.refresh('presented-token')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should issue a new access token when everything matches', async () => {
      jwtService.verify.mockReturnValue({
        sub: 'u1',
        email: 'user@test.com',
        role: Role.ADMIN,
        companyId: 'c1',
      });
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        deactivatedAt: null,
      });
      redisService.get.mockResolvedValue('presented-token');
      jwtService.sign.mockReturnValue('new-access-token');

      const result = await service.refresh('presented-token');
      expect(result).toEqual({ accessToken: 'new-access-token' });
    });
  });

  describe('logout', () => {
    it('should delete the stored refresh token', async () => {
      const result = await service.logout('u1');
      expect(redisService.del).toHaveBeenCalledWith('refresh:u1');
      expect(result).toEqual({ success: true });
    });
  });
});
