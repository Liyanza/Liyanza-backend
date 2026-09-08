import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtStrategy } from './jwt.strategy';
import { PrismaService } from '../../prisma/prisma.service';
import { Role } from '@prisma/client';
import { JwtPayload } from '../interfaces/authenticated-user.interface';

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

  const payload: JwtPayload = {
    sub: 'user-1',
    email: 'user@test.com',
    role: Role.ADMIN,
    companyId: 'company-1',
    type: 'access',
  };

  /** Utilisateur tel que réellement retourné par le `select` de la stratégie. */
  const dbUser = {
    id: 'user-1',
    email: 'user@test.com',
    role: Role.ADMIN,
    companyId: 'company-1',
    deactivatedAt: null,
  };

  it('should throw UnauthorizedException if payload is missing sub', async () => {
    await expect(strategy.validate({ ...payload, sub: '' })).rejects.toThrow(
      UnauthorizedException,
    );
  });

  // RÉGRESSION (faille critique corrigée) : un refresh token présenté comme
  // access token doit être rejeté. Avant correctif, les deux tokens étaient
  // signés avec le même secret et le même payload : celui-ci était donc
  // accepté, offrant 7 jours d'accès API au lieu de 15 minutes.
  it('should reject a refresh token used as an access token', async () => {
    await expect(
      strategy.validate({ ...payload, type: 'refresh' }),
    ).rejects.toThrow(UnauthorizedException);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('should throw UnauthorizedException if the user no longer exists', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(strategy.validate(payload)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('should throw UnauthorizedException if the user was deactivated (regression fix)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      ...dbUser,
      deactivatedAt: new Date(),
    });
    await expect(strategy.validate(payload)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('should return the authenticated user when active', async () => {
    prisma.user.findUnique.mockResolvedValue(dbUser);
    const result = await strategy.validate(payload);
    expect(result).toEqual({
      userId: 'user-1',
      email: 'user@test.com',
      role: Role.ADMIN,
      companyId: 'company-1',
    });
  });

  // RÉGRESSION (faille critique corrigée) : le rôle et la companyId doivent
  // provenir de la BASE, jamais des claims du token. Avant correctif, un
  // utilisateur rétrogradé conservait ses privilèges jusqu'à expiration.
  it('should source role and companyId from the database, not from the token', async () => {
    prisma.user.findUnique.mockResolvedValue({
      ...dbUser,
      role: Role.COMMUNITY_MANAGER,
      companyId: 'company-2',
    });

    const result = await strategy.validate(payload); // token dit ADMIN / company-1

    expect(result.role).toBe(Role.COMMUNITY_MANAGER);
    expect(result.companyId).toBe('company-2');
  });
});
