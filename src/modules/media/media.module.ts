import { Module } from '@nestjs/common';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { PrismaModule } from '../prisma/prisma.module';
import { S3MediaStorageProvider } from './providers/s3-media-storage.provider';
import { MEDIA_STORAGE_PROVIDER_TOKEN } from './interfaces/media-storage-provider.interface';

@Module({
  imports: [PrismaModule],
  controllers: [MediaController],
  providers: [
    MediaService,
    {
      provide: MEDIA_STORAGE_PROVIDER_TOKEN,
      useClass: S3MediaStorageProvider,
    },
  ],
  exports: [MediaService],
})
export class MediaModule {}
