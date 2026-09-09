/* eslint-disable @typescript-eslint/unbound-method */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import QRCode from 'qrcode';
import { QrCodeService } from './qr-code.service';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { QrCodeTargetType, Role } from '@prisma/client';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

jest.mock('qrcode', () => ({
  __esModule: true,
  default: { toDataURL: jest.fn() },
}));

describe('QrCodeService', () => {
  let service: QrCodeService;
  let prisma: jest.Mocked<PrismaService>;
  let queueService: jest.Mocked<QueueService>;

  const user: AuthenticatedUser = {
    userId: 'user-1',
    email: 'user@test.com',
    role: Role.ADMIN,
    companyId: 'company-1',
  };

  const mockCampaign = {
    id: 'campaign-1',
    launchedBy: { companyId: 'company-1' },
  };

  const mockQrCode = {
    id: 'qr-1',
    code: 'aBcD1234EfG',
    targetType: QrCodeTargetType.FORM,
    targetUrl: 'https://forms.example.com/x',
    zone: 'Bepanda',
    createdAt: new Date(),
    campaignId: 'campaign-1',
    installationId: null,
  };

  beforeEach(async () => {
    (QRCode.toDataURL as jest.Mock).mockResolvedValue(
      'data:image/png;base64,AAA',
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QrCodeService,
        {
          provide: PrismaService,
          useValue: {
            campaign: { findUnique: jest.fn() },
            installation: { findFirst: jest.fn() },
            qrCode: {
              findUnique: jest.fn(),
              create: jest.fn(),
              findMany: jest.fn(),
              count: jest.fn(),
            },
          },
        },
        {
          provide: QueueService,
          useValue: { addJob: jest.fn() },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) =>
              key === 'QR_CODE_BASE_URL' ? 'http://localhost:3000' : undefined,
            ),
          },
        },
      ],
    }).compile();

    service = module.get<QrCodeService>(QrCodeService);
    prisma = module.get(PrismaService);
    queueService = module.get(QueueService);
  });

  describe('create', () => {
    const dto = {
      targetType: QrCodeTargetType.FORM,
      targetUrl: 'https://forms.example.com/x',
      zone: 'Bepanda',
    };

    it('should throw ForbiddenException if the user has no company', async () => {
      const userNoCompany = { ...user, companyId: null };
      await expect(
        service.create('campaign-1', dto, userNoCompany),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw NotFoundException if the campaign does not exist', async () => {
      (prisma.campaign.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(service.create('campaign-1', dto, user)).rejects.toThrow(
        NotFoundException,
      );
    });

    // RÉGRESSION (isolation multi-tenant) : une campagne d'une autre
    // entreprise ne doit jamais pouvoir recevoir de QR code.
    it('should throw NotFoundException if the campaign belongs to another company', async () => {
      (prisma.campaign.findUnique as jest.Mock).mockResolvedValue({
        id: 'campaign-1',
        launchedBy: { companyId: 'other-company' },
      });
      await expect(service.create('campaign-1', dto, user)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException if installationId does not belong to the campaign', async () => {
      (prisma.campaign.findUnique as jest.Mock).mockResolvedValue(mockCampaign);
      (prisma.installation.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        service.create(
          'campaign-1',
          { ...dto, installationId: 'installation-x' },
          user,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if targetType is WHATSAPP but the URL does not match', async () => {
      (prisma.campaign.findUnique as jest.Mock).mockResolvedValue(mockCampaign);

      await expect(
        service.create(
          'campaign-1',
          {
            targetType: QrCodeTargetType.WHATSAPP,
            targetUrl: 'https://example.com/not-whatsapp',
            zone: 'Bepanda',
          },
          user,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should accept a valid wa.me URL for WHATSAPP', async () => {
      (prisma.campaign.findUnique as jest.Mock).mockResolvedValue(mockCampaign);
      (prisma.qrCode.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.qrCode.create as jest.Mock).mockResolvedValue({
        ...mockQrCode,
        targetType: QrCodeTargetType.WHATSAPP,
        targetUrl: 'https://wa.me/237600000000',
      });

      const result = await service.create(
        'campaign-1',
        {
          targetType: QrCodeTargetType.WHATSAPP,
          targetUrl: 'https://wa.me/237600000000',
          zone: 'Bepanda',
        },
        user,
      );
      expect(result.targetType).toBe(QrCodeTargetType.WHATSAPP);
    });

    it('should create the QR code and return the generated image', async () => {
      (prisma.campaign.findUnique as jest.Mock).mockResolvedValue(mockCampaign);
      (prisma.qrCode.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.qrCode.create as jest.Mock).mockResolvedValue(mockQrCode);

      const result = await service.create('campaign-1', dto, user);

      expect(prisma.qrCode.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            campaignId: 'campaign-1',
            zone: dto.zone,
            targetUrl: dto.targetUrl,
          }) as unknown,
        }),
      );
      expect(QRCode.toDataURL).toHaveBeenCalledWith(
        `http://localhost:3000/qr/${mockQrCode.code}`,
      );
      expect(result).toMatchObject({
        id: mockQrCode.id,
        scanCount: 0,
        qrCodeImage: 'data:image/png;base64,AAA',
      });
    });

    it('should retry code generation on collision and eventually give up', async () => {
      (prisma.campaign.findUnique as jest.Mock).mockResolvedValue(mockCampaign);
      // Toujours "déjà pris" -> épuise les tentatives.
      (prisma.qrCode.findUnique as jest.Mock).mockResolvedValue(mockQrCode);

      await expect(service.create('campaign-1', dto, user)).rejects.toThrow(
        InternalServerErrorException,
      );
      expect(prisma.qrCode.create).not.toHaveBeenCalled();
    });
  });

  describe('findAllForCampaign', () => {
    it('should throw NotFoundException if the campaign belongs to another company', async () => {
      (prisma.campaign.findUnique as jest.Mock).mockResolvedValue({
        id: 'campaign-1',
        launchedBy: { companyId: 'other-company' },
      });

      await expect(
        service.findAllForCampaign('campaign-1', { page: 1, limit: 10 }, user),
      ).rejects.toThrow(NotFoundException);
    });

    it('should return paginated items with per-QR scan counts and a per-zone aggregate', async () => {
      (prisma.campaign.findUnique as jest.Mock).mockResolvedValue(mockCampaign);
      (prisma.qrCode.findMany as jest.Mock)
        .mockResolvedValueOnce([
          { ...mockQrCode, zone: 'Bepanda', _count: { scans: 3 } },
        ])
        .mockResolvedValueOnce([
          { zone: 'Bepanda', _count: { scans: 3 } },
          { zone: 'Akwa', _count: { scans: 5 } },
          { zone: 'Bepanda', _count: { scans: 2 } },
        ]);
      (prisma.qrCode.count as jest.Mock).mockResolvedValue(1);

      const result = await service.findAllForCampaign(
        'campaign-1',
        { page: 1, limit: 10 },
        user,
      );

      expect(result.items[0]).toMatchObject({ scanCount: 3 });
      expect(result.byZone).toEqual({ Bepanda: 5, Akwa: 5 });
      expect(result.total).toBe(1);
    });
  });

  describe('resolveScan', () => {
    it('should throw NotFoundException if the code does not exist', async () => {
      (prisma.qrCode.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(service.resolveScan('unknown-code')).rejects.toThrow(
        NotFoundException,
      );
      expect(queueService.addJob).not.toHaveBeenCalled();
    });

    it('should enqueue the scan and return the stored target URL', async () => {
      (prisma.qrCode.findUnique as jest.Mock).mockResolvedValue(mockQrCode);

      const url = await service.resolveScan(mockQrCode.code);

      expect(url).toBe(mockQrCode.targetUrl);
      expect(queueService.addJob).toHaveBeenCalledWith(
        'qr-code-scan',
        'record-scan',
        expect.objectContaining({ qrCodeId: mockQrCode.id }) as unknown,
      );
    });
  });
});
