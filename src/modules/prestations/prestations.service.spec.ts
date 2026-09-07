/* eslint-disable @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PrestationsService } from './prestations.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { CampaignStatus, Role } from '@prisma/client';

type MockedPrisma = {
  campaign: { findFirst: jest.Mock };
  installation: { findUnique: jest.Mock; create: jest.Mock };
  publicationProof: { findUnique: jest.Mock; update: jest.Mock };
  $transaction: jest.Mock;
};

describe('PrestationsService', () => {
  let service: PrestationsService;
  let prisma: MockedPrisma;
  let jwtService: jest.Mocked<JwtService>;
  let configService: jest.Mocked<ConfigService>;
  let redisService: jest.Mocked<RedisService>;

  const adminUser: AuthenticatedUser = {
    userId: 'admin-1',
    email: 'admin@test.com',
    role: Role.ADMIN,
    companyId: 'company-1',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PrestationsService,
        {
          provide: PrismaService,
          useValue: {
            campaign: { findFirst: jest.fn() },
            installation: { findUnique: jest.fn(), create: jest.fn() },
            publicationProof: { findUnique: jest.fn(), update: jest.fn() },
            $transaction: jest.fn((cb: (tx: unknown) => unknown) => cb({})),
          },
        },
        {
          provide: JwtService,
          useValue: { sign: jest.fn(), verify: jest.fn() },
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn() },
        },
        {
          provide: RedisService,
          useValue: {
            set: jest.fn(),
            get: jest.fn(),
            del: jest.fn(),
            getDel: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<PrestationsService>(PrestationsService);
    prisma = module.get(PrismaService);
    jwtService = module.get(JwtService);
    configService = module.get(ConfigService);
    redisService = module.get(RedisService);
  });

  describe('generateValidationLink', () => {
    const installation = {
      id: 'inst-1',
      campaign: { launchedBy: { companyId: 'company-1' } },
      proof: { id: 'proof-1' },
    };

    it('should throw BadRequestException if no proof exists yet', async () => {
      prisma.installation.findUnique.mockResolvedValue({
        ...installation,
        proof: null,
      });
      await expect(
        service.generateValidationLink('inst-1', adminUser),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException if installation belongs to another company', async () => {
      prisma.installation.findUnique.mockResolvedValue({
        ...installation,
        campaign: { launchedBy: { companyId: 'other-company' } },
      });
      await expect(
        service.generateValidationLink('inst-1', adminUser),
      ).rejects.toThrow(NotFoundException);
    });

    it('should sign a token embedding a jti and register it as "unused" in redis', async () => {
      prisma.installation.findUnique.mockResolvedValue(installation);
      configService.get.mockImplementation((key: string) => {
        if (key === 'jwt.validationExpiration') return '7d';
        if (key === 'VALIDATION_BASE_URL') return 'https://app.test/validate';
        return undefined;
      });
      jwtService.sign.mockReturnValue('signed.jwt.token');

      const result = await service.generateValidationLink('inst-1', adminUser);

      expect(result.token).toBe('signed.jwt.token');
      expect(result.link).toBe('https://app.test/validate/signed.jwt.token');
      expect(jwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          sub: 'inst-1',
          type: 'validation',
          jti: expect.any(String) as string,
        }),
      );
      // Régression majeure : le jti DOIT être suivi côté Redis pour que
      // l'usage unique soit applicable lors de la consommation.
      expect(redisService.set).toHaveBeenCalledWith(
        expect.stringContaining('validation-link:'),
        'unused',
        expect.any(Number),
      );
    });
  });

  describe('consumeValidationLink', () => {
    const jti = 'jti-123';
    const validPayload = { sub: 'inst-1', type: 'validation' as const, jti };

    it('should reject an invalid/expired token', async () => {
      jwtService.verify.mockImplementation(() => {
        throw new Error('expired');
      });
      await expect(service.consumeValidationLink('bad-token')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should reject a token whose jti was never issued or already consumed', async () => {
      jwtService.verify.mockReturnValue(validPayload);
      redisService.getDel.mockResolvedValue(null);
      await expect(service.consumeValidationLink('token')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should reject a replayed (already-consumed) link', async () => {
      jwtService.verify.mockReturnValue(validPayload);
      // Le lien a déjà été consommé : GETDEL renvoie `null` la seconde fois.
      redisService.getDel.mockResolvedValue(null);

      await expect(service.consumeValidationLink('token')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should consume the link exactly once via an atomic GETDEL (no TOCTOU window)', async () => {
      jwtService.verify.mockReturnValue(validPayload);
      redisService.getDel.mockResolvedValue('unused');
      prisma.installation.findUnique.mockResolvedValue({
        id: 'inst-1',
        proof: { id: 'proof-1', validationStatus: 'PENDING' },
      });
      prisma.publicationProof.update.mockResolvedValue({
        id: 'proof-1',
        validationStatus: 'VALIDATED',
      });

      const result = await service.consumeValidationLink('token');

      expect(redisService.getDel).toHaveBeenCalledWith(
        `validation-link:${jti}`,
      );
      expect(prisma.publicationProof.update).toHaveBeenCalledWith({
        where: { installationId: 'inst-1' },
        data: { validationStatus: 'VALIDATED' },
      });
      expect(result.validationStatus).toBe('VALIDATED');
    });

    it('should throw NotFoundException if the installation or its proof no longer exists', async () => {
      jwtService.verify.mockReturnValue(validPayload);
      redisService.getDel.mockResolvedValue('unused');
      prisma.installation.findUnique.mockResolvedValue(null);

      await expect(service.consumeValidationLink('token')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('createPrestation', () => {
    it('should throw ForbiddenException if user has no company', async () => {
      await expect(
        service.createPrestation(
          'camp-1',
          {
            location: 'Douala',
            plannedLatitude: 4.05,
            plannedLongitude: 9.7,
            plannedInstallationDate: new Date().toISOString(),
          },
          { ...adminUser, companyId: null },
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw BadRequestException on a completed/cancelled campaign', async () => {
      prisma.campaign.findFirst.mockResolvedValue({
        id: 'camp-1',
        status: CampaignStatus.COMPLETED,
      });
      await expect(
        service.createPrestation(
          'camp-1',
          {
            location: 'Douala',
            plannedLatitude: 4.05,
            plannedLongitude: 9.7,
            plannedInstallationDate: new Date().toISOString(),
          },
          adminUser,
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
