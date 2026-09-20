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
  installation: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  publicationProof: {
    findUnique: jest.Mock;
    update: jest.Mock;
    create: jest.Mock;
  };
  statusHistory: { create: jest.Mock };
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
            installation: {
              findUnique: jest.fn(),
              findMany: jest.fn(),
              create: jest.fn(),
              update: jest.fn(),
            },
            publicationProof: {
              findUnique: jest.fn(),
              update: jest.fn(),
              create: jest.fn(),
            },
            statusHistory: { create: jest.fn() },
            user: { findFirst: jest.fn() },
            $transaction: jest.fn((cb: (tx: unknown) => unknown) =>
              cb({
                publicationProof: {
                  create: jest.fn().mockResolvedValue(undefined),
                },
                installation: { update: jest.fn() },
                statusHistory: { create: jest.fn() },
              }),
            ),
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
      plannedLatitude: 4.05,
      plannedLongitude: 9.7,
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
        distanceMeters: 0,
        locationMatch: true,
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

  describe('generateProofLink', () => {
    const installation = {
      id: 'inst-1',
      campaign: { launchedBy: { companyId: 'company-1' } },
    };

    it('should throw NotFoundException if installation belongs to another company', async () => {
      prisma.installation.findUnique.mockResolvedValue({
        ...installation,
        campaign: { launchedBy: { companyId: 'other-company' } },
      });
      await expect(
        service.generateProofLink('inst-1', adminUser),
      ).rejects.toThrow(NotFoundException);
    });

    // Contrairement à generateValidationLink, aucune preuve préalable n'est
    // exigée — c'est justement ce lien qui va permettre d'en créer une.
    it('should sign a proof link even when no proof exists yet', async () => {
      prisma.installation.findUnique.mockResolvedValue(installation);
      configService.get.mockImplementation((key: string) => {
        if (key === 'jwt.validationExpiration') return '7d';
        if (key === 'PROOF_SUBMISSION_BASE_URL')
          return 'https://app.test/preuve';
        return undefined;
      });
      jwtService.sign.mockReturnValue('signed.proof.token');

      const result = await service.generateProofLink('inst-1', adminUser);

      expect(result.token).toBe('signed.proof.token');
      expect(result.link).toBe('https://app.test/preuve/signed.proof.token');
      expect(redisService.set).toHaveBeenCalledWith(
        expect.stringContaining('proof-link:') as unknown,
        'unused',
        expect.any(Number) as unknown,
      );
    });
  });

  describe('consulterLienPreuve', () => {
    const payload = { sub: 'inst-1', type: 'proof' as const, jti: 'jti-1' };
    const installation = {
      id: 'inst-1',
      location: 'Bepanda, Douala',
      campaign: { name: 'Campagne Rentrée' },
      plannedInstallationDate: new Date('2026-10-01T00:00:00Z'),
      proof: null,
    };

    it('should reject a validation-type token (wrong link used on the wrong page)', async () => {
      jwtService.verify.mockReturnValue({ ...payload, type: 'validation' });
      await expect(service.consulterLienPreuve('token')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should report alreadySubmitted=false when no proof exists yet', async () => {
      jwtService.verify.mockReturnValue(payload);
      prisma.installation.findUnique.mockResolvedValue(installation);

      const result = await service.consulterLienPreuve('token');

      expect(result.alreadySubmitted).toBe(false);
      expect(result.campaignName).toBe('Campagne Rentrée');
      expect(redisService.getDel).not.toHaveBeenCalled();
    });

    it('should report alreadySubmitted=true when a proof already exists', async () => {
      jwtService.verify.mockReturnValue(payload);
      prisma.installation.findUnique.mockResolvedValue({
        ...installation,
        proof: { id: 'proof-1' },
      });

      const result = await service.consulterLienPreuve('token');

      expect(result.alreadySubmitted).toBe(true);
    });
  });

  describe('soumettrePreuveViaLien', () => {
    const payload = { sub: 'inst-1', type: 'proof' as const, jti: 'jti-1' };
    const installation = {
      id: 'inst-1',
      status: 'PLANNED',
      plannedLatitude: 4.05,
      plannedLongitude: 9.7,
    };
    const dto = {
      photo: 'https://cdn.test/proof.jpg',
      latitude: 4.05,
      longitude: 9.7,
      takenAt: '2026-10-01T10:00:00Z',
    };

    it('should reject a replayed (already consumed) link', async () => {
      jwtService.verify.mockReturnValue(payload);
      redisService.getDel.mockResolvedValue(null);

      await expect(
        service.soumettrePreuveViaLien('token', dto),
      ).rejects.toThrow(UnauthorizedException);
      expect(prisma.installation.findUnique).not.toHaveBeenCalled();
    });

    it('should reject a validation-type token', async () => {
      jwtService.verify.mockReturnValue({ ...payload, type: 'validation' });
      await expect(
        service.soumettrePreuveViaLien('token', dto),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should create the proof and report the GPS distance from the planned location', async () => {
      jwtService.verify.mockReturnValue(payload);
      redisService.getDel.mockResolvedValue('unused');
      prisma.installation.findUnique.mockResolvedValue(installation);
      prisma.publicationProof.findUnique.mockResolvedValue(null);
      prisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) =>
        cb({
          publicationProof: {
            create: jest.fn().mockResolvedValue({
              id: 'proof-1',
              latitude: dto.latitude,
              longitude: dto.longitude,
            }),
          },
          installation: { update: jest.fn() },
          statusHistory: { create: jest.fn() },
        }),
      );

      const result = await service.soumettrePreuveViaLien('token', dto);

      // Coordonnées identiques à celles prévues : distance nulle, donc
      // correspondance — vérifie que la comparaison Haversine est bien
      // branchée sur les deux bonnes paires de coordonnées.
      expect(result).toEqual({
        proofId: 'proof-1',
        distanceMeters: 0,
        locationMatch: true,
      });
    });

    it('should propagate ConflictException if a proof already exists for this installation', async () => {
      jwtService.verify.mockReturnValue(payload);
      redisService.getDel.mockResolvedValue('unused');
      prisma.installation.findUnique.mockResolvedValue(installation);
      prisma.publicationProof.findUnique.mockResolvedValue({ id: 'existing' });

      await expect(
        service.soumettrePreuveViaLien('token', dto),
      ).rejects.toThrow('A proof has already been submitted');
    });
  });

  describe('listInstallations', () => {
    it('should throw ForbiddenException if the user has no company', async () => {
      await expect(
        service.listInstallations({ ...adminUser, companyId: null }),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.installation.findMany).not.toHaveBeenCalled();
    });

    it('should compute the GPS distance and match flag for installations with a proof, and null for those without', async () => {
      prisma.installation.findMany.mockResolvedValue([
        {
          id: 'inst-1',
          location: 'Bepanda, Douala',
          campaignId: 'camp-1',
          campaign: { name: 'Campagne A' },
          status: 'INSTALLED',
          plannedLatitude: 4.05,
          plannedLongitude: 9.7,
          plannedInstallationDate: new Date('2026-10-01T00:00:00Z'),
          proof: {
            photo: 'https://cdn.test/a.jpg',
            latitude: 4.05,
            longitude: 9.7,
            takenAt: new Date('2026-10-02T00:00:00Z'),
            validationStatus: 'PENDING',
          },
        },
        {
          id: 'inst-2',
          location: 'Akwa, Douala',
          campaignId: 'camp-1',
          campaign: { name: 'Campagne A' },
          status: 'PLANNED',
          plannedLatitude: 4.05,
          plannedLongitude: 9.7,
          plannedInstallationDate: new Date('2026-10-01T00:00:00Z'),
          proof: null,
        },
      ]);

      const result = await service.listInstallations(adminUser);

      expect(result).toHaveLength(2);
      expect(result[0].distanceMeters).toBe(0);
      expect(result[0].locationMatch).toBe(true);
      expect(result[1].distanceMeters).toBeNull();
      expect(result[1].locationMatch).toBeNull();
      expect(prisma.installation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { campaign: { launchedBy: { companyId: 'company-1' } } },
        }) as unknown,
      );
    });
  });
});
