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
  user: { findFirst: jest.Mock };
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
            user: { findFirst: jest.fn() },
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
        data: { validationStatus: 'VALIDATED', validationComment: null },
      });
      expect(result.validationStatus).toBe('VALIDATED');
    });

    // BACK-308 : le commentaire externe (optionnel) doit être transmis tel
    // quel jusqu'à la persistance de la preuve.
    it('should persist the optional commentaire on the proof when provided', async () => {
      jwtService.verify.mockReturnValue(validPayload);
      redisService.getDel.mockResolvedValue('unused');
      prisma.installation.findUnique.mockResolvedValue({
        id: 'inst-1',
        proof: { id: 'proof-1', validationStatus: 'PENDING' },
      });
      prisma.publicationProof.update.mockResolvedValue({
        id: 'proof-1',
        validationStatus: 'VALIDATED',
        validationComment: 'Affichage conforme, RAS.',
      });

      await service.consumeValidationLink('token', 'Affichage conforme, RAS.');

      expect(prisma.publicationProof.update).toHaveBeenCalledWith({
        where: { installationId: 'inst-1' },
        data: {
          validationStatus: 'VALIDATED',
          validationComment: 'Affichage conforme, RAS.',
        },
      });
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

  describe('consulterLienValidation', () => {
    const jti = 'jti-456';
    const validPayload = { sub: 'inst-1', type: 'validation' as const, jti };
    const installationWithProof = {
      id: 'inst-1',
      location: 'Bepanda, Douala',
      proof: {
        photo: 'https://cdn.test/proof.jpg',
        latitude: 4.05,
        longitude: 9.7,
        takenAt: new Date('2026-09-01T10:00:00Z'),
        validationStatus: 'PENDING',
        validationComment: null,
      },
    };

    it('should reject an invalid/expired token', async () => {
      jwtService.verify.mockImplementation(() => {
        throw new Error('expired');
      });
      await expect(
        service.consulterLienValidation('bad-token'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw NotFoundException if the installation or its proof no longer exists', async () => {
      jwtService.verify.mockReturnValue(validPayload);
      prisma.installation.findUnique.mockResolvedValue(null);

      await expect(service.consulterLienValidation('token')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should return the proof for review WITHOUT touching Redis (does not consume the token)', async () => {
      jwtService.verify.mockReturnValue(validPayload);
      prisma.installation.findUnique.mockResolvedValue(installationWithProof);

      const result = await service.consulterLienValidation('token');

      expect(redisService.getDel).not.toHaveBeenCalled();
      expect(redisService.get).not.toHaveBeenCalled();
      expect(result).toEqual({
        location: 'Bepanda, Douala',
        photo: 'https://cdn.test/proof.jpg',
        latitude: 4.05,
        longitude: 9.7,
        takenAt: '2026-09-01T10:00:00.000Z',
        validationStatus: 'PENDING',
        validationComment: null,
      });
    });

    // RÉGRESSION : la consultation ne doit jamais empêcher la consommation
    // ultérieure du même lien — contrairement à l'ancien endpoint fusionné.
    it('should still allow the link to be consumed afterwards (consultation is read-only)', async () => {
      jwtService.verify.mockReturnValue(validPayload);
      prisma.installation.findUnique.mockResolvedValue(installationWithProof);

      await service.consulterLienValidation('token');

      redisService.getDel.mockResolvedValue('unused');
      prisma.publicationProof.update.mockResolvedValue({
        id: 'proof-1',
        validationStatus: 'VALIDATED',
      });
      await expect(
        service.consumeValidationLink('token'),
      ).resolves.toBeDefined();
    });
  });

  describe('createPrestation', () => {
    const baseDto = {
      location: 'Douala',
      plannedLatitude: 4.05,
      plannedLongitude: 9.7,
      plannedInstallationDate: new Date().toISOString(),
      providerId: 'provider-1',
    };

    it('should throw ForbiddenException if user has no company', async () => {
      await expect(
        service.createPrestation('camp-1', baseDto, {
          ...adminUser,
          companyId: null,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw BadRequestException on a completed/cancelled campaign', async () => {
      prisma.campaign.findFirst.mockResolvedValue({
        id: 'camp-1',
        status: CampaignStatus.COMPLETED,
      });
      await expect(
        service.createPrestation('camp-1', baseDto, adminUser),
      ).rejects.toThrow(BadRequestException);
    });

    // RÉGRESSION (écart fonctionnel majeur — endpoint mort) : avant le
    // correctif, `providerId` était toujours implicitement celui du
    // créateur (ADMIN/MARKETING_MANAGER), qui ne peut jamais avoir le rôle
    // PROVIDER exigé par `POST /prestations/:id/preuve` — aucun PROVIDER ne
    // pouvait donc jamais soumettre de preuve. `providerId` est désormais
    // obligatoire et validé côté serveur (existence, même entreprise, rôle).
    it('should throw NotFoundException if the assigned provider does not exist or belongs to another company', async () => {
      prisma.campaign.findFirst.mockResolvedValue({
        id: 'camp-1',
        status: CampaignStatus.PLANNED,
      });
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(
        service.createPrestation('camp-1', baseDto, adminUser),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.user.findFirst).toHaveBeenCalledWith({
        where: { id: 'provider-1', companyId: adminUser.companyId },
      });
      expect(prisma.installation.create).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException if the assigned user does not have the PROVIDER role', async () => {
      prisma.campaign.findFirst.mockResolvedValue({
        id: 'camp-1',
        status: CampaignStatus.PLANNED,
      });
      prisma.user.findFirst.mockResolvedValue({
        id: 'provider-1',
        role: Role.MARKETING_MANAGER,
      });

      await expect(
        service.createPrestation('camp-1', baseDto, adminUser),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.installation.create).not.toHaveBeenCalled();
    });

    it('should create the installation with the validated provider id', async () => {
      prisma.campaign.findFirst.mockResolvedValue({
        id: 'camp-1',
        status: CampaignStatus.PLANNED,
      });
      prisma.user.findFirst.mockResolvedValue({
        id: 'provider-1',
        role: Role.PROVIDER,
      });
      prisma.installation.create.mockResolvedValue({
        id: 'inst-1',
        providerId: 'provider-1',
      });

      const result = await service.createPrestation(
        'camp-1',
        baseDto,
        adminUser,
      );

      expect(prisma.installation.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          providerId: 'provider-1',
          campaignId: 'camp-1',
        }) as unknown,
      });
      expect(result.providerId).toBe('provider-1');
    });
  });
});
