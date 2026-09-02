/* eslint-disable @typescript-eslint/unbound-method */

import { Test, TestingModule } from '@nestjs/testing';
import {
  ConflictException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Role } from '@prisma/client';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

describe('UsersService', () => {
  let service: UsersService;
  let prisma: jest.Mocked<PrismaService>;
  let notificationsService: jest.Mocked<NotificationsService>;

  const mockUser: AuthenticatedUser = {
    userId: 'admin-1',
    email: 'admin@test.com',
    role: Role.ADMIN,
    companyId: 'company-1',
  };

  const mockSubAccount = {
    id: 'user-2',
    email: 'sub@test.com',
    firstName: 'Sub',
    lastName: 'Account',
    phone: '+237600000002',
    role: Role.MARKETING_MANAGER,
    companyId: 'company-1',
    createdAt: new Date(),
    deactivatedAt: null,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        {
          provide: PrismaService,
          useValue: {
            user: {
              findUnique: jest.fn(),
              create: jest.fn(),
              update: jest.fn(),
              findMany: jest.fn(),
            },
          },
        },
        {
          provide: NotificationsService,
          useValue: {
            creer: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
    prisma = module.get(PrismaService);
    notificationsService = module.get(NotificationsService);
  });

  describe('createSubAccount', () => {
    it('should create a sub-account and send a notification to the admin', async () => {
      const dto = {
        email: 'sub@test.com',
        firstName: 'Sub',
        lastName: 'Account',
        phone: '+237600000002',
        role: Role.MARKETING_MANAGER,
      };
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.user.create as jest.Mock).mockResolvedValue(mockSubAccount);
      (notificationsService.creer as jest.Mock).mockResolvedValue({
        id: 'notif-1',
      });

      const result = await service.createSubAccount(dto, mockUser);
      expect(result).toMatchObject({
        email: dto.email,
        role: dto.role,
        companyId: 'company-1',
      });
      expect(notificationsService.creer).toHaveBeenCalledWith({
        title: 'Sous-compte créé',
        message: expect.stringContaining(dto.email) as string,
        type: 'INFO',
        recipientId: mockUser.userId,
      });
    });

    it('should throw ConflictException if email already exists', async () => {
      const dto = {
        email: 'existing@test.com',
        firstName: 'Test',
        lastName: 'User',
        phone: '123',
        role: Role.MARKETING_MANAGER,
      };
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({
        id: 'existing',
      });

      await expect(service.createSubAccount(dto, mockUser)).rejects.toThrow(
        ConflictException,
      );
    });

    it('should throw ForbiddenException if admin has no company', async () => {
      const adminNoCompany = { ...mockUser, companyId: null };
      const dto = {
        email: 'test@test.com',
        firstName: 'Test',
        lastName: 'User',
        phone: '123',
        role: Role.MARKETING_MANAGER,
      };

      await expect(
        service.createSubAccount(dto, adminNoCompany),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('findAll', () => {
    it('should return all users of the admin company', async () => {
      (prisma.user.findMany as jest.Mock).mockResolvedValue([mockSubAccount]);

      const result = await service.findAll(mockUser);
      expect(result).toHaveLength(1);
      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { companyId: mockUser.companyId },
        }),
      );
    });

    it('should throw ForbiddenException if admin has no company', async () => {
      const adminNoCompany = { ...mockUser, companyId: null };
      await expect(service.findAll(adminNoCompany)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('updateRole', () => {
    it('should update role of a user in the same company', async () => {
      const targetUser = { id: 'user-2', companyId: 'company-1' };
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(targetUser);
      (prisma.user.update as jest.Mock).mockResolvedValue({
        ...mockSubAccount,
        role: Role.COMMUNITY_MANAGER,
      });

      const result = await service.updateRole(
        'user-2',
        Role.COMMUNITY_MANAGER,
        mockUser,
      );
      expect(result.role).toBe(Role.COMMUNITY_MANAGER);
    });

    it('should throw ForbiddenException if trying to change own role', async () => {
      await expect(
        service.updateRole('admin-1', Role.MARKETING_MANAGER, mockUser),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw NotFoundException if user not in same company', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({
        id: 'user-3',
        companyId: 'other-company',
      });

      await expect(
        service.updateRole('user-3', Role.ADMIN, mockUser),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('deactivate', () => {
    it('should deactivate a user in the same company', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({
        id: 'user-2',
        companyId: 'company-1',
      });
      (prisma.user.update as jest.Mock).mockResolvedValue({
        id: 'user-2',
        deactivatedAt: new Date(),
      });

      await service.deactivate('user-2', mockUser);
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-2' },
        data: { deactivatedAt: expect.any(Date) as Date },
      });
    });

    it('should throw NotFoundException if user not found', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(service.deactivate('unknown', mockUser)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getProfile', () => {
    it('should return the profile of the authenticated user', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockSubAccount);

      const result = await service.getProfile({
        ...mockUser,
        userId: 'user-2',
      });
      expect(result).toEqual(mockSubAccount);
    });

    it('should throw NotFoundException if user not found', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(service.getProfile(mockUser)).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
