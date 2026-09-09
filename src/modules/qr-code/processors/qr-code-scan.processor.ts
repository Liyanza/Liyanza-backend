import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

interface RecordScanPayload {
  qrCodeId: string;
  scannedAt: string;
}

/**
 * Persiste les scans de QR code de façon asynchrone (file `qr-code-scan`,
 * déclarée dans `QueueModule` — BACK-301). La route publique `GET /qr/:code`
 * ne fait qu'enfiler ce job avant de rediriger, pour garder la redirection
 * perçue par le client final indépendante de l'écriture en base (BACK-305).
 */
@Processor('qr-code-scan')
export class QrCodeScanProcessor extends WorkerHost {
  private readonly logger = new Logger(QrCodeScanProcessor.name);

  constructor(private prisma: PrismaService) {
    super();
  }

  async process(job: Job<RecordScanPayload>): Promise<void> {
    if (job.name !== 'record-scan') {
      return;
    }

    const { qrCodeId, scannedAt } = job.data;

    try {
      await this.prisma.qrCodeScan.create({
        data: { qrCodeId, scannedAt: new Date(scannedAt) },
      });
    } catch (error) {
      // Un QR code supprimé entre le scan et le traitement du job (violation
      // de contrainte FK, P2003) ne doit jamais être retenté indéfiniment —
      // on journalise et on abandonne ce job précis. Toute AUTRE erreur (ex:
      // DB temporairement indisponible) doit en revanche être relancée pour
      // que la politique de retry/backoff de BullMQ (BACK-301) s'applique.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2003'
      ) {
        this.logger.warn(
          `Discarding scan job: qrCodeId=${qrCodeId} no longer exists.`,
        );
        return;
      }
      throw error;
    }
  }
}
