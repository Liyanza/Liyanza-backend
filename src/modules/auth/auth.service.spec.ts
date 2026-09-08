/* eslint-disable @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { Prisma, Role } from '@prisma/client';

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
              create: jest.fn(),
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
            getDel: jest.fn(),
            delByPattern: jest.fn(),
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

    // CORRECTIF AUDIT : l'unicité n'est plus vérifiée par un `findUnique`
    // préalable (non atomique, sujet à une race condition entre deux
    // inscriptions simultanées) mais déléguée à la contrainte `@unique` de la
    // base, dont le code d'erreur P2002 est traduit en 409.
    it('should throw ConflictException if the email is already used (P2002)', async () => {
      const p2002 = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the fields: (`email`)',
        { code: 'P2002', clientVersion: 'test' },
      );
      (
        prisma as unknown as { user: { create: jest.Mock } }
      ).user.create.mockRejectedValue(p2002);

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

    it('should return tokens and store the refresh jti in redis on success', async () => {
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

      const result = await service.login(loginDto);

      expect(result.accessToken).toBe('access-token');
      expect(result.refreshToken).toBe('refresh-token');
      // La clé est indexée par jti (et non plus par userId seul) afin de
      // permettre plusieurs sessions simultanées — web + mobile.
      expect(redisService.set).toHaveBeenCalledWith(
        expect.stringMatching(/^refresh:u1:[0-9a-f-]{36}$/),
        '1',
        expect.any(Number),
      );
    });

    // RÉGRESSION (faille critique corrigée) : access token et refresh token
    // doivent porter des claims `type` distincts. Sans cela, le refresh token
    // était directement utilisable comme Bearer token pendant 7 jours.
    it('should sign the access and refresh tokens with distinct type claims', async () => {
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
      jwtService.sign.mockReturnValue('token');

      await service.login(loginDto);

      const [accessPayload] = jwtService.sign.mock.calls[0] as [
        { type: string },
      ];
      const [refreshPayload] = jwtService.sign.mock.calls[1] as [
        { type: string; jti: string },
      ];
      expect(accessPayload.type).toBe('access');
      expect(refreshPayload.type).toBe('refresh');
      expect(refreshPayload.jti).toEqual(expect.any(String));
    });

    // NOTE : la régression « bcrypt doit tourner même sur un e-mail inconnu »
    // (énumération de comptes par canal temporel) est couverte dans
    // `auth.service.timing.spec.ts` — le module natif `bcrypt` expose des
    // propriétés non redéfinissables, `jest.spyOn` y échoue et un
    // `jest.mock('bcrypt')` global casserait les hachages réels utilisés par
    // les tests ci-dessus.
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

    // RÉGRESSION (faille critique corrigée) : un ACCESS token ne doit jamais
    // pouvoir être échangé contre une nouvelle session.
    it('should reject an access token presented to the refresh endpoint', async () => {
      jwtService.verify.mockReturnValue({
        sub: 'u1',
        type: 'access',
        jti: 'j1',
      });

      await expect(service.refresh('access-token')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(redisService.getDel).not.toHaveBeenCalled();
    });

    // RÉGRESSION (majeur — rejeu) : le refresh token est à usage unique. Son
    // jti est consommé atomiquement ; un second usage doit échouer.
    it('should reject a replayed refresh token (jti already consumed)', async () => {
      jwtService.verify.mockReturnValue({
        sub: 'u1',
        type: 'refresh',
        jti: 'j1',
      });
      redisService.getDel.mockResolvedValue(null);

      await expect(service.refresh('replayed-token')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should issue a rotated token pair when everything matches', async () => {
      jwtService.verify.mockReturnValue({
        sub: 'u1',
        email: 'user@test.com',
        role: Role.ADMIN,
        companyId: 'c1',
        type: 'refresh',
        jti: 'j1',
      });
      redisService.getDel.mockResolvedValue('1');
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        email: 'user@test.com',
        role: Role.ADMIN,
        companyId: 'c1',
        deactivatedAt: null,
      });
      jwtService.sign.mockReturnValueOnce('new-access-token');
      jwtService.sign.mockReturnValueOnce('new-refresh-token');

      const result = await service.refresh('presented-token');

      expect(result).toEqual({
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
      });
      expect(redisService.getDel).toHaveBeenCalledWith('refresh:u1:j1');
    });

    // RÉGRESSION (faille critique corrigée) : le rôle du nouveau token doit
    // provenir de la BASE. Avant correctif, `refresh()` recopiait le rôle de
    // l'ancien token : un utilisateur rétrogradé conservait ADMIN pendant 7
    // jours en rafraîchissant sa session.
    it('should rebuild the token from the database role, not the old claims', async () => {
      jwtService.verify.mockReturnValue({
        sub: 'u1',
        email: 'user@test.com',
        role: Role.ADMIN, // ancien rôle, périmé
        companyId: 'c1',
        type: 'refresh',
        jti: 'j1',
      });
      redisService.getDel.mockResolvedValue('1');
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        email: 'user@test.com',
        role: Role.COMMUNITY_MANAGER, // rôle réel, rétrogradé
        companyId: 'c1',
        deactivatedAt: null,
      });
      jwtService.sign.mockReturnValue('token');

      await service.refresh('presented-token');

      const [accessPayload] = jwtService.sign.mock.calls[0] as [{ role: Role }];
      expect(accessPayload.role).toBe(Role.COMMUNITY_MANAGER);
    });

    it('should reject a refresh token belonging to a deactivated account', async () => {
      jwtService.verify.mockReturnValue({
        sub: 'u1',
        type: 'refresh',
        jti: 'j1',
      });
      redisService.getDel.mockResolvedValue('1');
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        deactivatedAt: new Date(),
      });

      await expect(service.refresh('presented-token')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('logout', () => {
    it('should revoke every session when no refresh token is provided', async () => {
      const result = await service.logout('u1');
      expect(redisService.delByPattern).toHaveBeenCalledWith('refresh:u1:*');
      expect(result).toEqual({ success: true });
    });

    it('should revoke only the current session when a refresh token is provided', async () => {
      jwtService.verify.mockReturnValue({
        sub: 'u1',
        type: 'refresh',
        jti: 'j1',
      });

      const result = await service.logout('u1', 'refresh-token');

      expect(redisService.del).toHaveBeenCalledWith('refresh:u1:j1');
      expect(redisService.delByPattern).not.toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });
  });
});
