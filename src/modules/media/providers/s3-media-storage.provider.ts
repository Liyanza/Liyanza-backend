import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  MediaStorageProvider,
  ObjectMetadata,
  PresignedDownloadUrl,
  PresignedUploadUrl,
} from '../interfaces/media-storage-provider.interface';

// Durée de validité courte des URL présignées : l'upload/la lecture doit se
// faire dans la foulée de la demande, jamais des URL de longue durée qui
// resteraient valides si interceptées/loguées par erreur côté client.
const UPLOAD_URL_TTL_SECONDS = 5 * 60;
const DOWNLOAD_URL_TTL_SECONDS = 5 * 60;

@Injectable()
export class S3MediaStorageProvider implements MediaStorageProvider {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(configService: ConfigService) {
    this.bucket = configService.get<string>('S3_BUCKET')!;
    const endpoint = configService.get<string>('S3_ENDPOINT');

    this.client = new S3Client({
      region: configService.get<string>('S3_REGION'),
      endpoint,
      // Style "path" (bucket dans le chemin, pas en sous-domaine) requis par
      // MinIO et la plupart des setups S3-compatibles auto-hébergés.
      forcePathStyle:
        configService.get<string>('S3_FORCE_PATH_STYLE') === 'true',
      credentials: {
        accessKeyId: configService.get<string>('S3_ACCESS_KEY_ID')!,
        secretAccessKey: configService.get<string>('S3_SECRET_ACCESS_KEY')!,
      },
    });
  }

  async getPresignedUploadUrl(
    key: string,
    contentType: string,
  ): Promise<PresignedUploadUrl> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
    });
    const url = await getSignedUrl(this.client, command, {
      expiresIn: UPLOAD_URL_TTL_SECONDS,
    });
    return {
      url,
      expiresAt: new Date(Date.now() + UPLOAD_URL_TTL_SECONDS * 1000),
    };
  }

  async getPresignedDownloadUrl(key: string): Promise<PresignedDownloadUrl> {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    const url = await getSignedUrl(this.client, command, {
      expiresIn: DOWNLOAD_URL_TTL_SECONDS,
    });
    return {
      url,
      expiresAt: new Date(Date.now() + DOWNLOAD_URL_TTL_SECONDS * 1000),
    };
  }

  async headObject(key: string): Promise<ObjectMetadata | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        contentType: result.ContentType ?? 'application/octet-stream',
        sizeBytes: result.ContentLength ?? 0,
      };
    } catch (error) {
      if (
        error instanceof S3ServiceException &&
        error.$metadata.httpStatusCode === 404
      ) {
        return null;
      }
      throw error;
    }
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }
}
