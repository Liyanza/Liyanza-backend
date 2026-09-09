import { randomBytes } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { MediaStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { assertSameCompany } from '../auth/utils/company-scope.util';
import { MEDIA_STORAGE_PROVIDER_TOKEN } from './interfaces/media-storage-provider.interface';
import type { MediaStorageProvider } from './interfaces/media-storage-provider.interface';
import { CreatePresignedUploadDto } from './dto/create-presigned-upload.dto';

const MAX_KEY_GENERATION_ATTEMPTS = 3;

// Limite volontairement basse : ce module sert des preuves/documents
// (photos d'installation, justificatifs), pas un stockage de fichiers
// générique. Une limite haute serait un vecteur de coût/DoS sur le stockage.
export const MAX_MEDIA_SIZE_BYTES = 10 * 1024 * 1024; // 10 Mo

@Injectable()
export class MediaService {
  constructor(
    private prisma: PrismaService,
    @Inject(MEDIA_STORAGE_PROVIDER_TOKEN)
    private storageProvider: MediaStorageProvider,
  ) {}

  private generateKey(companyId: string): string {
    // Imprévisible (128 bits d'entropie) pour empêcher l'énumération/l'accès
    // à l'objet d'une autre entreprise si l'URL présignée venait à fuiter —
    // voir .claude/skills/liyanza-security-guardrails/SKILL.md §10. Le
    // préfixe companyId ne sert qu'à l'organisation du bucket, pas à la
    // sécurité (portée par l'aléa).
    return `${companyId}/${randomBytes(16).toString('base64url')}`;
  }

  private async createMediaWithUniqueKey(
    contentType: string,
    user: AuthenticatedUser & { companyId: string },
  ) {
    for (let attempt = 0; attempt < MAX_KEY_GENERATION_ATTEMPTS; attempt++) {
      const key = this.generateKey(user.companyId);
      const existing = await this.prisma.media.findUnique({
        where: { key },
      });
      if (existing) {
        continue;
      }
      return this.prisma.media.create({
        data: {
          key,
          contentType,
          companyId: user.companyId,
          uploadedById: user.userId,
        },
      });
    }
    throw new InternalServerErrorException(
      'Impossible de générer une clé de stockage unique, réessayez.',
    );
  }

  /**
   * Réserve un emplacement de stockage et retourne une URL PUT présignée à
   * courte durée de vie : le client uploade directement vers le stockage
   * S3-compatible, le fichier ne transite jamais par ce serveur (BACK-307).
   */
  async createPresignedUpload(
    dto: CreatePresignedUploadDto,
    user: AuthenticatedUser,
  ) {
    if (!user.companyId) {
      throw new ForbiddenException(
        'Vous devez appartenir à une entreprise pour uploader un fichier.',
      );
    }

    const media = await this.createMediaWithUniqueKey(
      dto.contentType,
      user as AuthenticatedUser & { companyId: string },
    );
    const { url, expiresAt } = await this.storageProvider.getPresignedUploadUrl(
      media.key,
      dto.contentType,
    );

    return { mediaId: media.id, uploadUrl: url, expiresAt };
  }

  /**
   * À appeler par le client une fois l'upload PUT terminé. Vérifie la
   * présence réelle de l'objet et sa taille/type via `HeadObject` — la
   * confiance ne repose jamais sur la seule déclaration du client.
   */
  async confirmUpload(mediaId: string, user: AuthenticatedUser) {
    const media = await this.prisma.media.findUnique({
      where: { id: mediaId },
    });
    if (!media) {
      throw new NotFoundException('Média introuvable.');
    }
    assertSameCompany(user, media.companyId, 'Média');

    if (media.status === MediaStatus.CONFIRMED) {
      return media;
    }

    const metadata = await this.storageProvider.headObject(media.key);
    if (!metadata) {
      throw new BadRequestException(
        "Le fichier n'a pas été détecté sur le stockage — effectuez l'upload avant de confirmer.",
      );
    }

    if (metadata.sizeBytes > MAX_MEDIA_SIZE_BYTES) {
      await this.storageProvider.deleteObject(media.key);
      throw new BadRequestException(
        `Fichier trop volumineux (${metadata.sizeBytes} octets, maximum ${MAX_MEDIA_SIZE_BYTES}).`,
      );
    }

    if (metadata.contentType !== media.contentType) {
      await this.storageProvider.deleteObject(media.key);
      throw new BadRequestException(
        'Le type de fichier uploadé ne correspond pas à celui déclaré.',
      );
    }

    const result = await this.prisma.media.updateMany({
      where: { id: mediaId, status: MediaStatus.PENDING },
      data: {
        status: MediaStatus.CONFIRMED,
        sizeBytes: metadata.sizeBytes,
        confirmedAt: new Date(),
      },
    });
    if (result.count === 0) {
      throw new ConflictException(
        'Ce média a été confirmé entre-temps, réessayez.',
      );
    }

    return this.prisma.media.findUniqueOrThrow({ where: { id: mediaId } });
  }

  /**
   * Bucket privé : aucune URL publique directe. Toute lecture passe par une
   * URL de lecture présignée à courte durée de vie, uniquement pour un média
   * confirmé et appartenant à l'entreprise de l'utilisateur.
   */
  async getDownloadUrl(mediaId: string, user: AuthenticatedUser) {
    const media = await this.prisma.media.findUnique({
      where: { id: mediaId },
    });
    if (!media) {
      throw new NotFoundException('Média introuvable.');
    }
    assertSameCompany(user, media.companyId, 'Média');

    if (media.status !== MediaStatus.CONFIRMED) {
      throw new BadRequestException("Ce fichier n'a pas encore été confirmé.");
    }

    return this.storageProvider.getPresignedDownloadUrl(media.key);
  }
}
