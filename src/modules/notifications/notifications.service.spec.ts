/* eslint-disable @typescript-eslint/unbound-method */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */

import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Role } from '@prisma/client';
import { NotificationType } from './dto/create-notification.dto';

describe('NotificationsService', () => {
  let service: NotificationsService;
  let prisma: jest.Mocked<PrismaService>;

  const mockUser: AuthenticatedUser = {
    userId: 'user-1',
    email: 'test@test.com',
    role: Role.ADMIN,
    companyId: 'company-1',
  };

  const mockNotification = {
    id: 'notif-1',
    title: 'Test Notification',
    message: 'This is a test',
    type: 'INFO' as string,
    sentAt: new Date('2026-09-01T10:00:00Z'),
    readStatus: 'UNREAD',
    recipientId: 'user-1',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        {
          provide: PrismaService,
          useValue: {
            notification: {
              create: jest.fn(),
              findMany: jest.fn(),
              findFirst: jest.fn(),
              update: jest.fn(),
              count: jest.fn(),
            },
          },
        },
      ],
    }).compile();

    service = module.get<NotificationsService>(NotificationsService);
    prisma = module.get(PrismaService);
  });

  describe('creer', () => {
    it('should create a notification with correct data', async () => {
      const dto = {
        title: 'Test',
        message: 'Message',
        type: NotificationType.INFO,
        recipientId: 'user-1',
      };
      (prisma.notification.create as jest.Mock).mockResolvedValue(
        mockNotification,
      );

      const result = await service.creer(dto);
      expect(result).toEqual(mockNotification);
      expect(prisma.notification.create).toHaveBeenCalledWith({
        data: {
          title: dto.title,
          message: dto.message,
          type: dto.type,
          sentAt: expect.any(Date) as Date,
          readStatus: 'UNREAD',
          recipientId: dto.recipientId,
        },
      });
    });

    it('should default type to INFO if not provided', async () => {
      const dto = {
        title: 'Test',
        message: 'Message',
        recipientId: 'user-1',
      };
      (prisma.notification.create as jest.Mock).mockResolvedValue(
        mockNotification,
      );

      await service.creer(dto);
      expect(prisma.notification.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          type: NotificationType.INFO,
        }),
      });
    });
  });

  describe('findAll', () => {
    it('should return notifications for the authenticated user', async () => {
      (prisma.notification.findMany as jest.Mock).mockResolvedValue([
        mockNotification,
      ]);
      (prisma.notification.count as jest.Mock).mockResolvedValue(1);

      const result = await service.findAll(mockUser, {});
      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(prisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { recipientId: mockUser.userId },
        }),
      );
    });

    it('should filter by readStatus', async () => {
      (prisma.notification.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.notification.count as jest.Mock).mockResolvedValue(0);

      await service.findAll(mockUser, { readStatus: 'UNREAD' });
      expect(prisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { recipientId: mockUser.userId, readStatus: 'UNREAD' },
        }),
      );
    });

    it('should not filter by readStatus if ALL', async () => {
      (prisma.notification.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.notification.count as jest.Mock).mockResolvedValue(0);

      await service.findAll(mockUser, { readStatus: 'ALL' });
      expect(prisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { recipientId: mockUser.userId },
        }),
      );
    });

    it('should apply pagination correctly', async () => {
      (prisma.notification.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.notification.count as jest.Mock).mockResolvedValue(0);

      await service.findAll(mockUser, { page: 2, limit: 10 });
      expect(prisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 10,
          skip: 10, // (2-1)*10
        }),
      );
    });
  });

  describe('markAsLue', () => {
    it('should mark a notification as read', async () => {
      (prisma.notification.findFirst as jest.Mock).mockResolvedValue(
        mockNotification,
      );
      (prisma.notification.update as jest.Mock).mockResolvedValue({
        ...mockNotification,
        readStatus: 'READ',
      });

      const result = await service.markAsLue('notif-1', mockUser);
      expect(result.readStatus).toBe('READ');
      expect(prisma.notification.update).toHaveBeenCalledWith({
        where: { id: 'notif-1' },
        data: { readStatus: 'READ' },
      });
    });

    it('should be idempotent if already read', async () => {
      const readNotification = { ...mockNotification, readStatus: 'READ' };
      (prisma.notification.findFirst as jest.Mock).mockResolvedValue(
        readNotification,
      );

      const result = await service.markAsLue('notif-1', mockUser);
      expect(result).toEqual(readNotification);
      expect(prisma.notification.update).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException if notification not found', async () => {
      (prisma.notification.findFirst as jest.Mock).mockResolvedValue(null);
      await expect(service.markAsLue('invalid', mockUser)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException if notification belongs to another user', async () => {
      (prisma.notification.findFirst as jest.Mock).mockResolvedValue(null);
      await expect(
        service.markAsLue('notif-1', { ...mockUser, userId: 'other-user' }),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
