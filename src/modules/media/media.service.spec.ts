/* eslint-disable @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { MediaStatus, Role } from '@prisma/client';
import { MediaService, MAX_MEDIA_SIZE_BYTES } from './media.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import {
  MEDIA_STORAGE_PROVIDER_TOKEN,
  MediaStorageProvider,
} from './interfaces/media-storage-provider.interface';

describe('MediaService', () => {
  let service: MediaService;
  let prisma: jest.Mocked<PrismaService>;
  let storageProvider: jest.Mocked<MediaStorageProvider>;

  const mockUser: AuthenticatedUser = {
    userId: 'user-1',
    email: 'test@test.com',
    role: Role.MARKETING_MANAGER,
    companyId: 'company-1',
  };

  const mockMedia = {
    id: 'media-1',
    key: 'company-1/abc123',
    contentType: 'image/png',
    sizeBytes: null as number | null,
    status: MediaStatus.PENDING,
    createdAt: new Date('2026-09-09T00:00:00Z'),
    confirmedAt: null as Date | null,
    companyId: 'company-1',
    uploadedById: 'user-1',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MediaService,
        {
          provide: PrismaService,
          useValue: {
            media: {
              findUnique: jest.fn(),
              create: jest.fn(),
              updateMany: jest.fn(),
              findUniqueOrThrow: jest.fn(),
            },
          },
        },
        {
          provide: MEDIA_STORAGE_PROVIDER_TOKEN,
          useValue: {
            getPresignedUploadUrl: jest.fn(),
            getPresignedDownloadUrl: jest.fn(),
            headObject: jest.fn(),
            deleteObject: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<MediaService>(MediaService);
    prisma = module.get(PrismaService);
    storageProvider = module.get(MEDIA_STORAGE_PROVIDER_TOKEN);
  });

  describe('createPresignedUpload', () => {
    it('should throw ForbiddenException if the user has no company', async () => {
      await expect(
        service.createPresignedUpload(
          { contentType: 'image/png' },
          { ...mockUser, companyId: null },
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should create a PENDING Media row scoped to the company and return a presigned URL', async () => {
      (prisma.media.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.media.create as jest.Mock).mockResolvedValue(mockMedia);
      storageProvider.getPresignedUploadUrl.mockResolvedValue({
        url: 'https://minio.local/put-url',
        expiresAt: new Date('2026-09-09T00:05:00Z'),
      });

      const result = await service.createPresignedUpload(
        { contentType: 'image/png' },
        mockUser,
      );

      expect(prisma.media.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          contentType: 'image/png',
          companyId: 'company-1',
          uploadedById: 'user-1',
        }) as unknown,
      });
      expect(storageProvider.getPresignedUploadUrl).toHaveBeenCalledWith(
        mockMedia.key,
        'image/png',
      );
      expect(result).toEqual({
        mediaId: mockMedia.id,
        uploadUrl: 'https://minio.local/put-url',
        expiresAt: new Date('2026-09-09T00:05:00Z'),
      });
    });

    // RÉGRESSION : la clé de stockage doit toujours être générée côté
    // serveur (imprévisible), jamais dérivée d'une entrée client — voir
    // .claude/skills/liyanza-security-guardrails/SKILL.md §10.
    it('should retry key generation on collision and eventually give up', async () => {
      (prisma.media.findUnique as jest.Mock).mockResolvedValue(mockMedia); // toujours "déjà pris"

      await expect(
        service.createPresignedUpload({ contentType: 'image/png' }, mockUser),
      ).rejects.toThrow(InternalServerErrorException);
      expect(prisma.media.findUnique).toHaveBeenCalledTimes(3);
      expect(prisma.media.create).not.toHaveBeenCalled();
    });
  });

  describe('confirmUpload', () => {
    it('should throw NotFoundException if the media does not exist', async () => {
      (prisma.media.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(service.confirmUpload('unknown', mockUser)).rejects.toThrow(
        NotFoundException,
      );
    });

    // RÉGRESSION (isolation multi-tenant) : impossible de confirmer/lire le
    // média d'une autre entreprise, même en connaissant son id.
    it('should throw NotFoundException if the media belongs to another company', async () => {
      (prisma.media.findUnique as jest.Mock).mockResolvedValue({
        ...mockMedia,
        companyId: 'other-company',
      });
      await expect(service.confirmUpload('media-1', mockUser)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should be idempotent if already CONFIRMED (no HeadObject call)', async () => {
      const confirmed = { ...mockMedia, status: MediaStatus.CONFIRMED };
      (prisma.media.findUnique as jest.Mock).mockResolvedValue(confirmed);

      const result = await service.confirmUpload('media-1', mockUser);

      expect(result).toEqual(confirmed);
      expect(storageProvider.headObject).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException if the object was never actually uploaded', async () => {
      (prisma.media.findUnique as jest.Mock).mockResolvedValue(mockMedia);
      storageProvider.headObject.mockResolvedValue(null);

      await expect(service.confirmUpload('media-1', mockUser)).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.media.updateMany).not.toHaveBeenCalled();
    });

    it('should reject and delete the object if it exceeds the max size', async () => {
      (prisma.media.findUnique as jest.Mock).mockResolvedValue(mockMedia);
      storageProvider.headObject.mockResolvedValue({
        contentType: 'image/png',
        sizeBytes: MAX_MEDIA_SIZE_BYTES + 1,
      });

      await expect(service.confirmUpload('media-1', mockUser)).rejects.toThrow(
        BadRequestException,
      );
      expect(storageProvider.deleteObject).toHaveBeenCalledWith(mockMedia.key);
      expect(prisma.media.updateMany).not.toHaveBeenCalled();
    });

    it('should reject and delete the object if the content type does not match', async () => {
      (prisma.media.findUnique as jest.Mock).mockResolvedValue(mockMedia);
      storageProvider.headObject.mockResolvedValue({
        contentType: 'application/pdf',
        sizeBytes: 1000,
      });

      await expect(service.confirmUpload('media-1', mockUser)).rejects.toThrow(
        BadRequestException,
      );
      expect(storageProvider.deleteObject).toHaveBeenCalledWith(mockMedia.key);
    });

    it('should mark the media CONFIRMED with the real size when verification passes', async () => {
      (prisma.media.findUnique as jest.Mock).mockResolvedValue(mockMedia);
      storageProvider.headObject.mockResolvedValue({
        contentType: 'image/png',
        sizeBytes: 2048,
      });
      (prisma.media.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      const confirmed = {
        ...mockMedia,
        status: MediaStatus.CONFIRMED,
        sizeBytes: 2048,
      };
      (prisma.media.findUniqueOrThrow as jest.Mock).mockResolvedValue(
        confirmed,
      );

      const result = await service.confirmUpload('media-1', mockUser);

      expect(prisma.media.updateMany).toHaveBeenCalledWith({
        where: { id: 'media-1', status: MediaStatus.PENDING },
        data: expect.objectContaining({
          status: MediaStatus.CONFIRMED,
          sizeBytes: 2048,
        }) as unknown,
      });
      expect(result).toEqual(confirmed);
    });

    // Verrou optimiste : deux confirmations quasi simultanées ne doivent
    // jamais toutes les deux réussir silencieusement.
    it('should throw ConflictException if the media was confirmed concurrently (count: 0)', async () => {
      (prisma.media.findUnique as jest.Mock).mockResolvedValue(mockMedia);
      storageProvider.headObject.mockResolvedValue({
        contentType: 'image/png',
        sizeBytes: 2048,
      });
      (prisma.media.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

      await expect(service.confirmUpload('media-1', mockUser)).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('getDownloadUrl', () => {
    it('should throw NotFoundException if the media does not exist', async () => {
      (prisma.media.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(service.getDownloadUrl('unknown', mockUser)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException if the media belongs to another company', async () => {
      (prisma.media.findUnique as jest.Mock).mockResolvedValue({
        ...mockMedia,
        status: MediaStatus.CONFIRMED,
        companyId: 'other-company',
      });
      await expect(service.getDownloadUrl('media-1', mockUser)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw BadRequestException if the media is not yet CONFIRMED', async () => {
      (prisma.media.findUnique as jest.Mock).mockResolvedValue(mockMedia);
      await expect(service.getDownloadUrl('media-1', mockUser)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should return a presigned download URL for a confirmed media', async () => {
      (prisma.media.findUnique as jest.Mock).mockResolvedValue({
        ...mockMedia,
        status: MediaStatus.CONFIRMED,
      });
      storageProvider.getPresignedDownloadUrl.mockResolvedValue({
        url: 'https://minio.local/get-url',
        expiresAt: new Date('2026-09-09T00:05:00Z'),
      });

      const result = await service.getDownloadUrl('media-1', mockUser);

      expect(storageProvider.getPresignedDownloadUrl).toHaveBeenCalledWith(
        mockMedia.key,
      );
      expect(result.url).toBe('https://minio.local/get-url');
    });
  });
});
