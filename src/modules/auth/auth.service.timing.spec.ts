import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { Role } from '@prisma/client';

// `bcrypt` est un module natif : ses exports ne sont pas redéfinissables, donc
// `jest.spyOn(bcrypt, 'compare')` lève « Cannot redefine property ». On mocke
// donc le module entier — d'où ce fichier de spec séparé, pour ne pas priver
// `auth.service.spec.ts` des hachages réels dont il a besoin.
jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('hashed'),
  compare: jest.fn().mockResolvedValue(false),
}));

const mockedCompare = bcrypt.compare as unknown as jest.Mock;

/**
 * RÉGRESSION (correctif audit — énumération de comptes par canal temporel).
 *
 * `login()` retournait auparavant AVANT d'appeler `bcrypt.compare` lorsque
 * l'e-mail était inconnu ou le compte désactivé. Les messages d'erreur étaient
 * bien uniformes ('Invalid credentials.'), mais pas les temps de réponse :
 * bcrypt au coût 10 prend ~60-100 ms, un écart trivialement mesurable à
 * distance. Un attaquant pouvait ainsi valider en masse quels e-mails
 * possèdent un compte — une fuite exploitable pour du phishing ciblé ou du
 * credential stuffing.
 *
 * Le correctif exécute systématiquement une comparaison, contre un hash leurre
 * lorsque aucun utilisateur ne correspond.
 */
describe('AuthService — résistance à l’énumération de comptes', () => {
  let service: AuthService;
  let prisma: { user: { findUnique: jest.Mock } };

  const loginDto = { email: 'user@test.com', password: 'SuperSecret1' };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockedCompare.mockResolvedValue(false);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: PrismaService,
          useValue: { user: { findUnique: jest.fn(), create: jest.fn() } },
        },
        {
          provide: JwtService,
          useValue: { sign: jest.fn(), verify: jest.fn(), decode: jest.fn() },
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
        { provide: ConfigService, useValue: { get: jest.fn() } },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    prisma = module.get(PrismaService);
  });

  it('exécute une comparaison bcrypt même lorsque le compte n’existe pas', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(service.login(loginDto)).rejects.toThrow(
      UnauthorizedException,
    );

    expect(mockedCompare).toHaveBeenCalledTimes(1);
    // Comparé au hash leurre, jamais à `undefined` — sinon bcrypt lèverait
    // immédiatement et le court-circuit temporel réapparaîtrait.
    expect(mockedCompare).toHaveBeenCalledWith(
      loginDto.password,
      expect.stringMatching(/^\$2[aby]\$/),
    );
  });

  it('exécute une comparaison bcrypt même lorsque le compte est désactivé', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      email: loginDto.email,
      password: '$2b$10$somehashvaluethatislongenoughxxxxxxxxxxxxxxxxxxxxxxxx',
      role: Role.ADMIN,
      companyId: 'c1',
      deactivatedAt: new Date(),
    });

    await expect(service.login(loginDto)).rejects.toThrow(
      UnauthorizedException,
    );

    expect(mockedCompare).toHaveBeenCalledTimes(1);
  });

  it('refuse la connexion d’un compte désactivé même avec le bon mot de passe', async () => {
    mockedCompare.mockResolvedValue(true);
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      email: loginDto.email,
      password: '$2b$10$somehashvaluethatislongenoughxxxxxxxxxxxxxxxxxxxxxxxx',
      role: Role.ADMIN,
      companyId: 'c1',
      deactivatedAt: new Date(),
    });

    await expect(service.login(loginDto)).rejects.toThrow(
      UnauthorizedException,
    );
  });
});
