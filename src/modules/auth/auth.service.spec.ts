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
import { EMAIL_PROVIDER_TOKEN } from '../mail/interfaces/email-provider.interface';
import {
  GOOGLE_OAUTH_CLIENT_TOKEN,
  FACEBOOK_OAUTH_CLIENT_TOKEN,
} from './clients/oauth-login-client.interface';

type MockedPrisma = {
  user: {
    findUnique: jest.Mock;
    findUniqueOrThrow: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
};

describe('AuthService', () => {
  let service: AuthService;
  let prisma: MockedPrisma;
  let jwtService: jest.Mocked<JwtService>;
  let redisService: jest.Mocked<RedisService>;
  let emailProvider: { send: jest.Mock };
  let googleClient: {
    getAuthorizationUrl: jest.Mock;
    exchangeCodeForProfile: jest.Mock;
  };
  let facebookClient: {
    getAuthorizationUrl: jest.Mock;
    exchangeCodeForProfile: jest.Mock;
  };
  let configService: { get: jest.Mock; getOrThrow: jest.Mock };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: PrismaService,
          useValue: {
            user: {
              findUnique: jest.fn(),
              findUniqueOrThrow: jest.fn(),
              create: jest.fn(),
              update: jest.fn(),
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
            getOrThrow: jest.fn(),
          },
        },
        {
          provide: EMAIL_PROVIDER_TOKEN,
          useValue: { send: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: GOOGLE_OAUTH_CLIENT_TOKEN,
          useValue: {
            getAuthorizationUrl: jest.fn(),
            exchangeCodeForProfile: jest.fn(),
          },
        },
        {
          provide: FACEBOOK_OAUTH_CLIENT_TOKEN,
          useValue: {
            getAuthorizationUrl: jest.fn(),
            exchangeCodeForProfile: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    prisma = module.get(PrismaService);
    jwtService = module.get(JwtService);
    redisService = module.get(RedisService);
    emailProvider = module.get(EMAIL_PROVIDER_TOKEN);
    googleClient = module.get(GOOGLE_OAUTH_CLIENT_TOKEN);
    facebookClient = module.get(FACEBOOK_OAUTH_CLIENT_TOKEN);
    configService = module.get(ConfigService);
    configService.getOrThrow.mockImplementation(
      (key: string) => `config:${key}`,
    );
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

  describe('forgotPassword', () => {
    const dto = { email: 'user@test.com' };

    it('should return success without sending an email when no account matches (anti-enumeration)', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      const result = await service.forgotPassword(dto);

      expect(result).toEqual({ success: true });
      expect(emailProvider.send).not.toHaveBeenCalled();
      expect(redisService.set).not.toHaveBeenCalled();
    });

    it('should return success without sending an email for a deactivated account', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        email: dto.email,
        password: 'hashed',
        deactivatedAt: new Date(),
      });

      await service.forgotPassword(dto);

      expect(emailProvider.send).not.toHaveBeenCalled();
    });

    // Un compte 100% Google/Facebook n'a pas de mot de passe local à
    // réinitialiser — même comportement uniforme (toujours success) que les
    // autres branches anti-énumération ci-dessus.
    it('should return success without sending an email for an OAuth-only account (no local password)', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        email: dto.email,
        password: null,
        deactivatedAt: null,
      });

      await service.forgotPassword(dto);

      expect(emailProvider.send).not.toHaveBeenCalled();
    });

    it('should store a single-use token in Redis and email the reset link for an eligible account', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        email: dto.email,
        firstName: 'Jane',
        password: 'hashed',
        deactivatedAt: null,
      });
      configService.getOrThrow.mockImplementation((key: string) =>
        key === 'PASSWORD_RESET_URL'
          ? 'https://app.liyanza.com/reset-password'
          : `config:${key}`,
      );

      await service.forgotPassword(dto);

      expect(redisService.set).toHaveBeenCalledWith(
        expect.stringMatching(/^password-reset:/),
        'u1',
        expect.any(Number),
      );
      expect(emailProvider.send).toHaveBeenCalledWith(
        expect.objectContaining({
          to: dto.email,
          text: expect.stringContaining(
            'https://app.liyanza.com/reset-password?token=',
          ) as unknown,
        }),
      );
    });

    it('should not let an email delivery failure bubble up to the caller', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        email: dto.email,
        firstName: 'Jane',
        password: 'hashed',
        deactivatedAt: null,
      });
      emailProvider.send.mockRejectedValue(new Error('SMTP down'));

      await expect(service.forgotPassword(dto)).resolves.toEqual({
        success: true,
      });
    });
  });

  describe('resetPassword', () => {
    it('should throw UnauthorizedException for an invalid or expired token', async () => {
      redisService.getDel.mockResolvedValue(null);

      await expect(
        service.resetPassword({ token: 'bad', newPassword: 'NewPassword1' }),
      ).rejects.toThrow(UnauthorizedException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    // CORRECTIF AUDIT (cohérence) : une réinitialisation doit révoquer toutes
    // les sessions existantes, pas seulement changer le mot de passe.
    it('should update the password and revoke every existing session', async () => {
      redisService.getDel.mockResolvedValue('u1');

      const result = await service.resetPassword({
        token: 'good-token',
        newPassword: 'NewPassword1',
      });

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { password: expect.any(String) as unknown },
      });
      expect(redisService.delByPattern).toHaveBeenCalledWith('refresh:u1:*');
      expect(result).toEqual({ success: true });
    });
  });

  describe('startOAuthLogin', () => {
    it('should store an anti-CSRF state in Redis and return the provider authorization URL', async () => {
      googleClient.getAuthorizationUrl.mockReturnValue(
        'https://accounts.google.com/o/oauth2/v2/auth?...',
      );

      const result = await service.startOAuthLogin('google');

      expect(redisService.set).toHaveBeenCalledWith(
        expect.stringMatching(/^oauth-login-state:/),
        '1',
        expect.any(Number),
      );
      expect(result).toEqual({
        authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?...',
      });
    });

    it('should use the Facebook client for the facebook provider', async () => {
      facebookClient.getAuthorizationUrl.mockReturnValue(
        'https://facebook.com/dialog/oauth?...',
      );

      const result = await service.startOAuthLogin('facebook');

      expect(googleClient.getAuthorizationUrl).not.toHaveBeenCalled();
      expect(result.authorizationUrl).toBe(
        'https://facebook.com/dialog/oauth?...',
      );
    });
  });

  describe('handleOAuthLoginCallback', () => {
    beforeEach(() => {
      configService.getOrThrow.mockImplementation((key: string) =>
        key === 'OAUTH_LOGIN_REDIRECT_URL'
          ? 'https://app.liyanza.com/connexion/oauth-callback'
          : `config:${key}`,
      );
    });

    it('should redirect with reason=denied without consuming the state when the provider reports an error', async () => {
      const result = await service.handleOAuthLoginCallback('google', {
        state: 's1',
        error: 'access_denied',
      });

      expect(redisService.getDel).not.toHaveBeenCalled();
      expect(result.redirectUrl).toContain('status=error');
      expect(result.redirectUrl).toContain('reason=denied');
    });

    it('should redirect with reason=invalid_or_expired_state when the state cannot be consumed', async () => {
      redisService.getDel.mockResolvedValue(null);

      const result = await service.handleOAuthLoginCallback('google', {
        state: 'replayed-or-unknown',
        code: 'abc',
      });

      expect(result.redirectUrl).toContain('reason=invalid_or_expired_state');
    });

    it('should redirect with reason=missing_code when the callback has no code', async () => {
      redisService.getDel.mockResolvedValue('1');

      const result = await service.handleOAuthLoginCallback('google', {
        state: 's1',
      });

      expect(result.redirectUrl).toContain('reason=missing_code');
    });

    it('should redirect with reason=exchange_failed when the provider client throws', async () => {
      redisService.getDel.mockResolvedValue('1');
      googleClient.exchangeCodeForProfile.mockRejectedValue(
        new Error('Google OAuth token exchange failed'),
      );

      const result = await service.handleOAuthLoginCallback('google', {
        state: 's1',
        code: 'abc',
      });

      expect(result.redirectUrl).toContain('reason=exchange_failed');
    });

    it('should create a new COMMUNITY_MANAGER user with no company on first login, issue tokens and return a one-time exchange code', async () => {
      redisService.getDel.mockResolvedValue('1');
      googleClient.exchangeCodeForProfile.mockResolvedValue({
        providerId: 'google-sub-1',
        email: 'new-oauth-user@test.com',
        firstName: 'Ada',
        lastName: 'Lovelace',
      });
      prisma.user.findUnique.mockResolvedValue(null); // ni par googleId, ni par email
      prisma.user.create.mockResolvedValue({
        id: 'u-new',
        email: 'new-oauth-user@test.com',
        firstName: 'Ada',
        lastName: 'Lovelace',
        role: Role.COMMUNITY_MANAGER,
        companyId: null,
        deactivatedAt: null,
      });
      jwtService.sign.mockReturnValueOnce('access-token');
      jwtService.sign.mockReturnValueOnce('refresh-token');

      const result = await service.handleOAuthLoginCallback('google', {
        state: 's1',
        code: 'abc',
      });

      expect(prisma.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          role: Role.COMMUNITY_MANAGER,
          companyId: null,
          password: null,
          googleId: 'google-sub-1',
        }) as unknown,
      });
      expect(redisService.set).toHaveBeenCalledWith(
        expect.stringMatching(/^oauth-exchange:/),
        expect.stringContaining('access-token') as unknown,
        expect.any(Number),
      );
      expect(result.redirectUrl).toContain('status=success');
      expect(result.redirectUrl).toContain('code=');
    });

    // Une même personne inscrite par email/mot de passe qui se connecte
    // ensuite via Google doit être RATTACHÉE à son compte existant, jamais
    // dupliquée — `email` est l'identifiant métier unique.
    it('should link an existing email/password account instead of creating a duplicate', async () => {
      redisService.getDel.mockResolvedValue('1');
      googleClient.exchangeCodeForProfile.mockResolvedValue({
        providerId: 'google-sub-2',
        email: 'existing@test.com',
        firstName: 'Existing',
        lastName: 'User',
      });
      prisma.user.findUnique
        .mockResolvedValueOnce(null) // pas encore lié par googleId
        .mockResolvedValueOnce({
          id: 'u-existing',
          email: 'existing@test.com',
          deactivatedAt: null,
        }); // déjà inscrit par mot de passe
      prisma.user.update.mockResolvedValue({
        id: 'u-existing',
        email: 'existing@test.com',
        deactivatedAt: null,
      });
      jwtService.sign.mockReturnValue('token');

      await service.handleOAuthLoginCallback('google', {
        state: 's1',
        code: 'abc',
      });

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u-existing' },
        data: { googleId: 'google-sub-2' },
      });
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('should reuse the account already linked to this provider id, without re-querying by email', async () => {
      redisService.getDel.mockResolvedValue('1');
      googleClient.exchangeCodeForProfile.mockResolvedValue({
        providerId: 'google-sub-3',
        email: 'already-linked@test.com',
        firstName: 'Already',
        lastName: 'Linked',
      });
      prisma.user.findUnique.mockResolvedValueOnce({
        id: 'u-linked',
        email: 'already-linked@test.com',
        deactivatedAt: null,
      });
      jwtService.sign.mockReturnValue('token');

      await service.handleOAuthLoginCallback('google', {
        state: 's1',
        code: 'abc',
      });

      expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('should redirect with reason=account_disabled for a deactivated account', async () => {
      redisService.getDel.mockResolvedValue('1');
      googleClient.exchangeCodeForProfile.mockResolvedValue({
        providerId: 'google-sub-4',
        email: 'disabled@test.com',
        firstName: 'Disabled',
        lastName: 'User',
      });
      prisma.user.findUnique.mockResolvedValueOnce({
        id: 'u-disabled',
        email: 'disabled@test.com',
        deactivatedAt: new Date(),
      });

      const result = await service.handleOAuthLoginCallback('google', {
        state: 's1',
        code: 'abc',
      });

      expect(result.redirectUrl).toContain('reason=account_disabled');
      expect(jwtService.sign).not.toHaveBeenCalled();
    });
  });

  describe('exchangeOAuthCode', () => {
    it('should throw UnauthorizedException for an invalid or expired exchange code', async () => {
      redisService.getDel.mockResolvedValue(null);

      await expect(
        service.exchangeOAuthCode({ code: 'bad-or-replayed' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should return the parsed token pair for a valid exchange code (single use, via GETDEL)', async () => {
      const payload = {
        accessToken: 'a',
        refreshToken: 'r',
        user: {
          id: 'u1',
          email: 'user@test.com',
          firstName: 'A',
          lastName: 'B',
          role: Role.COMMUNITY_MANAGER,
        },
      };
      redisService.getDel.mockResolvedValue(JSON.stringify(payload));

      const result = await service.exchangeOAuthCode({ code: 'good-code' });

      expect(result).toEqual(payload);
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
