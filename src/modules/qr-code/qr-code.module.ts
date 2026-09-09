import { Module } from '@nestjs/common';
import { QrCodeController } from './qr-code.controller';
import { QrCodeService } from './qr-code.service';
import { QrCodeScanProcessor } from './processors/qr-code-scan.processor';
import { PrismaModule } from '../prisma/prisma.module';
import { QueueModule } from '../queue/queue.module';

@Module({
  imports: [PrismaModule, QueueModule],
  controllers: [QrCodeController],
  providers: [QrCodeService, QrCodeScanProcessor],
})
export class QrCodeModule {}
