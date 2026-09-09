/* eslint-disable @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { MonitoringService } from './monitoring.service';
import { PrismaService } from '../prisma/prisma.service';
import { DiffusionsService } from '../diffusions/diffusions.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/dto/create-notification.dto';

describe('MonitoringService', () => {
  let service: MonitoringService;
  let prisma: {
    broadcast: { findUnique: jest.Mock; findUniqueOrThrow: jest.Mock };
  };
  let diffusionsService: jest.Mocked<DiffusionsService>;
  let notificationsService: jest.Mocked<NotificationsService>;

  const broadcast = {
    id: 'broadcast-1',
    mediaType: 'RADIO',
    scheduledAt: new Date('2026-09-10T08:00:00Z'),
    campaign: {
      name: 'Campagne Demo',
      launchedBy: { id: 'manager-1' },
    },
  };

  const dto = {
    diffusionId: 'broadcast-1',
    detectedAt: '2026-09-10T08:05:00Z',
    audioProof: 'https://cdn.test/audio-proof.mp3',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MonitoringService,
        {
          provide: PrismaService,
          useValue: {
            broadcast: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn() },
          },
        },
        {
          provide: DiffusionsService,
          useValue: { applyConstat: jest.fn() },
        },
        {
          provide: NotificationsService,
          useValue: { creer: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<MonitoringService>(MonitoringService);
    prisma = module.get(PrismaService);
    diffusionsService = module.get(DiffusionsService);
    notificationsService = module.get(NotificationsService);
  });

  it('should throw NotFoundException if the diffusion does not exist', async () => {
    prisma.broadcast.findUnique.mockResolvedValue(null);

    await expect(service.recordDetection(dto)).rejects.toThrow(
      NotFoundException,
    );
    expect(diffusionsService.applyConstat).not.toHaveBeenCalled();
  });

  it('should record the constat via DiffusionsService.applyConstat (no direct Prisma write)', async () => {
    prisma.broadcast.findUnique.mockResolvedValue(broadcast);
    diffusionsService.applyConstat.mockResolvedValue({
      ...broadcast,
      actualBroadcastAt: new Date(dto.detectedAt),
    } as never);

    await service.recordDetection(dto);

    expect(diffusionsService.applyConstat).toHaveBeenCalledWith('broadcast-1', {
      actualBroadcastAt: dto.detectedAt,
      audioProof: dto.audioProof,
    });
  });

  it('should NOT notify when the deviation stays within the threshold (5 min)', async () => {
    prisma.broadcast.findUnique.mockResolvedValue(broadcast);
    diffusionsService.applyConstat.mockResolvedValue(broadcast as never);

    await service.recordDetection(dto); // scheduledAt 08:00, detectedAt 08:05 → 5 min

    expect(notificationsService.creer).not.toHaveBeenCalled();
  });

  // Régression : l'écart doit être comparé en valeur absolue — une
  // diffusion détectée EN AVANCE (négatif) doit aussi déclencher l'alerte.
  it('should notify the campaign owner when the deviation exceeds the threshold, in either direction', async () => {
    prisma.broadcast.findUnique.mockResolvedValue(broadcast);
    diffusionsService.applyConstat.mockResolvedValue(broadcast as never);

    await service.recordDetection({
      ...dto,
      detectedAt: '2026-09-10T07:30:00Z', // 30 min EN AVANCE
    });

    expect(notificationsService.creer).toHaveBeenCalledWith(
      expect.objectContaining({
        type: NotificationType.WARNING,
        recipientId: 'manager-1',
      }),
    );
  });

  // RÉGRESSION (idempotence webhook) : un rejeu réseau du même webhook (ou
  // une course concurrente perdue face au verrou optimiste de
  // `applyConstat`) ne doit jamais être traité comme une erreur, ni
  // déclencher une seconde notification.
  it('should treat an already-recorded detection as an idempotent no-op, without notifying again', async () => {
    prisma.broadcast.findUnique.mockResolvedValue(broadcast);
    diffusionsService.applyConstat.mockRejectedValue(
      new ConflictException('already recorded'),
    );
    prisma.broadcast.findUniqueOrThrow.mockResolvedValue({
      ...broadcast,
      actualBroadcastAt: new Date('2026-09-10T08:05:00Z'),
    });

    const result = await service.recordDetection(dto);

    expect(result).toEqual(
      expect.objectContaining({ id: 'broadcast-1' }) as unknown,
    );
    expect(notificationsService.creer).not.toHaveBeenCalled();
  });

  it('should rethrow any error from applyConstat that is not a ConflictException', async () => {
    prisma.broadcast.findUnique.mockResolvedValue(broadcast);
    diffusionsService.applyConstat.mockRejectedValue(new Error('db down'));

    await expect(service.recordDetection(dto)).rejects.toThrow('db down');
  });
});
