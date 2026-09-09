import { randomBytes } from 'crypto';
import QRCode from 'qrcode';
import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QrCodeTargetType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { assertSameCompany } from '../auth/utils/company-scope.util';
import { CreateQrCodeDto } from './dto/create-qr-code.dto';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

// Cohérence type ↔ URL cible : WHATSAPP doit pointer vers un vrai lien
// WhatsApp. Volontairement pas de vraie whitelist de domaines configurable
// par entreprise dans ce ticket (décision produit hors scope BACK-305) —
// voir docs/BACKLOG_REORIENTE.md.
const WHATSAPP_URL_PATTERN = /^https:\/\/(wa\.me|api\.whatsapp\.com)\//;
const MAX_CODE_GENERATION_ATTEMPTS = 3;

@Injectable()
export class QrCodeService {
  constructor(
    private prisma: PrismaService,
    private queueService: QueueService,
    private configService: ConfigService,
  ) {}

  private assertTargetUrlMatchesType(
    targetType: QrCodeTargetType,
    targetUrl: string,
  ): void {
    if (
      targetType === QrCodeTargetType.WHATSAPP &&
      !WHATSAPP_URL_PATTERN.test(targetUrl)
    ) {
      throw new BadRequestException(
        'targetUrl doit pointer vers wa.me ou api.whatsapp.com pour le type WHATSAPP.',
      );
    }
  }

  private generateCode(): string {
    // Imprévisible (64 bits d'entropie) pour empêcher l'énumération de
    // zones/campagnes concurrentes — voir
    // .claude/skills/liyanza-security-guardrails/SKILL.md §10.
    return randomBytes(8).toString('base64url');
  }

  private buildPublicUrl(code: string): string {
    const baseUrl = this.configService.get<string>('QR_CODE_BASE_URL');
    if (!baseUrl) {
      throw new InternalServerErrorException(
        'QR code base URL not configured.',
      );
    }
    return `${baseUrl}/qr/${code}`;
  }

  private async createWithUniqueCode(campaignId: string, dto: CreateQrCodeDto) {
    for (let attempt = 0; attempt < MAX_CODE_GENERATION_ATTEMPTS; attempt++) {
      const code = this.generateCode();
      const existing = await this.prisma.qrCode.findUnique({
        where: { code },
      });
      if (existing) {
        continue;
      }
      return this.prisma.qrCode.create({
        data: {
          code,
          targetType: dto.targetType,
          targetUrl: dto.targetUrl,
          zone: dto.zone,
          campaignId,
          installationId: dto.installationId,
        },
      });
    }
    throw new InternalServerErrorException(
      'Impossible de générer un identifiant de QR code unique, réessayez.',
    );
  }

  async create(
    campaignId: string,
    dto: CreateQrCodeDto,
    user: AuthenticatedUser,
  ) {
    if (!user.companyId) {
      throw new ForbiddenException(
        'Vous devez appartenir à une entreprise pour générer un QR code.',
      );
    }

    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      include: { launchedBy: true },
    });
    if (!campaign) {
      throw new NotFoundException('Campagne introuvable.');
    }
    assertSameCompany(user, campaign.launchedBy.companyId, 'Campagne');

    if (dto.installationId) {
      const installation = await this.prisma.installation.findFirst({
        where: { id: dto.installationId, campaignId },
      });
      if (!installation) {
        throw new NotFoundException(
          'Installation introuvable pour cette campagne.',
        );
      }
    }

    this.assertTargetUrlMatchesType(dto.targetType, dto.targetUrl);

    const qrCode = await this.createWithUniqueCode(campaignId, dto);
    const qrCodeImage = await QRCode.toDataURL(
      this.buildPublicUrl(qrCode.code),
    );

    return { ...qrCode, scanCount: 0, qrCodeImage };
  }

  async findAllForCampaign(
    campaignId: string,
    query: PaginationQueryDto,
    user: AuthenticatedUser,
  ) {
    if (!user.companyId) {
      throw new ForbiddenException(
        'Vous devez appartenir à une entreprise pour consulter les QR codes.',
      );
    }

    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      include: { launchedBy: true },
    });
    if (!campaign) {
      throw new NotFoundException('Campagne introuvable.');
    }
    assertSameCompany(user, campaign.launchedBy.companyId, 'Campagne');

    const limit = query.limit ?? 10;
    const page = query.page ?? 1;
    const skip = (page - 1) * limit;

    const [items, total, allForZoneAggregation] = await Promise.all([
      this.prisma.qrCode.findMany({
        where: { campaignId },
        include: { _count: { select: { scans: true } } },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip,
      }),
      this.prisma.qrCode.count({ where: { campaignId } }),
      // Agrégat calculé sur l'ensemble des QR codes de la campagne, pas
      // seulement la page courante, pour rester exact.
      this.prisma.qrCode.findMany({
        where: { campaignId },
        select: { zone: true, _count: { select: { scans: true } } },
      }),
    ]);

    const byZone = allForZoneAggregation.reduce<Record<string, number>>(
      (acc, qr) => {
        acc[qr.zone] = (acc[qr.zone] ?? 0) + qr._count.scans;
        return acc;
      },
      {},
    );

    return {
      items: items.map(({ _count, ...qr }) => ({
        ...qr,
        scanCount: _count.scans,
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      byZone,
    };
  }

  /**
   * Résout un scan public (`GET /qr/:code`) : renvoie l'URL cible et enfile
   * l'enregistrement du scan de façon asynchrone (file `qr-code-scan`), pour
   * ne jamais ralentir la redirection perçue par le client final
   * (BACK-305 : < 300 ms).
   */
  async resolveScan(code: string): Promise<string> {
    const qrCode = await this.prisma.qrCode.findUnique({ where: { code } });
    if (!qrCode) {
      throw new NotFoundException('QR code introuvable.');
    }

    await this.queueService.addJob('qr-code-scan', 'record-scan', {
      qrCodeId: qrCode.id,
      scannedAt: new Date().toISOString(),
    });

    return qrCode.targetUrl;
  }
}
