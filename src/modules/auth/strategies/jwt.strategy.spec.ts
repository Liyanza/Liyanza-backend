import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtStrategy } from './jwt.strategy';
import { PrismaService } from '../../prisma/prisma.service';
import { Role } from '@prisma/client';

describe('JwtStrategy', () => {
  let strategy: JwtStrategy;
  let prisma: { user: { findUnique: jest.Mock } };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JwtStrategy,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue('test-secret'),
          },
        },
        {
          provide: PrismaService,
          useValue: {
            user: { findUnique: jest.fn() },
          },
        },
      ],
    }).compile();

    strategy = module.get<JwtStrategy>(JwtStrategy);
    prisma = module.get(PrismaService);
  });

  const payload = {
    sub: 'user-1',
    email: 'user@test.com',
    role: Role.ADMIN,
    companyId: 'company-1',
  };

  it('should throw UnauthorizedException if payload is missing sub/role', async () => {
    await expect(strategy.validate({ ...payload, sub: '' })).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('should throw UnauthorizedException if the user no longer exists', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(strategy.validate(payload)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('should throw UnauthorizedException if the user was deactivated (regression fix)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      deactivatedAt: new Date(),
    });
    await expect(strategy.validate(payload)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('should return the authenticated user when active', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      deactivatedAt: null,
    });
    const result = await strategy.validate(payload);
    expect(result).toEqual({
      userId: 'user-1',
      email: 'user@test.com',
      role: Role.ADMIN,
      companyId: 'company-1',
    });
  });
});
