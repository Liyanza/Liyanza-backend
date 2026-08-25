/* eslint-disable @typescript-eslint/unbound-method */
/* eslint-disable @typescript-eslint/no-unsafe-argument */

import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { EntreprisesService } from './entreprises.service';
import { PrismaService } from '../prisma/prisma.service';
import { Role } from '@prisma/client';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

describe('EntreprisesService', () => {
  let service: EntreprisesService;
  let prisma: jest.Mocked<PrismaService>;

  const mockUser: AuthenticatedUser = {
    userId: 'user-1',
    email: 'test@test.com',
    role: Role.ADMIN,
    companyId: null,
  };

  const mockCompany = {
    id: 'company-1',
    name: 'Test SARL',
    businessSector: 'Tech',
    address: 'Douala, Cameroon',
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EntreprisesService,
        {
          provide: PrismaService,
          useValue: {
            company: {
              create: jest.fn(),
              findFirst: jest.fn(),
              update: jest.fn(),
              findMany: jest.fn(),
              count: jest.fn(),
            },
            user: {
              update: jest.fn(),
            },
          },
        },
      ],
    }).compile();

    service = module.get<EntreprisesService>(EntreprisesService);
    prisma = module.get(PrismaService);
  });

  describe('create', () => {
    it('should create a company and assign user as ADMIN', async () => {
      const dto = {
        name: 'New Co',
        businessSector: 'Agri',
        address: 'Yaoundé',
      };
      const user = { ...mockUser, companyId: null };

      (prisma.company.create as jest.Mock).mockResolvedValue({
        ...mockCompany,
        ...dto,
      });
      (prisma.user.update as jest.Mock).mockResolvedValue({} as any);

      const result = await service.create(dto, user);
      expect(result).toMatchObject(dto);
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: user.userId },
        data: { companyId: mockCompany.id, role: Role.ADMIN },
      });
    });

    it('should throw ConflictException if user already has a company', async () => {
      const userWithCompany = { ...mockUser, companyId: 'existing' };
      await expect(service.create({} as any, userWithCompany)).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('findOne', () => {
    it('should return company if it exists and user belongs to it', async () => {
      const user = { ...mockUser, companyId: 'company-1' };
      (prisma.company.findFirst as jest.Mock).mockResolvedValue(mockCompany);

      const result = await service.findOne('company-1', user);
      expect(result).toEqual(mockCompany);
    });

    it('should throw NotFoundException if company is soft-deleted or not found', async () => {
      (prisma.company.findFirst as jest.Mock).mockResolvedValue(null);
      await expect(service.findOne('unknown', mockUser)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException if user does not belong to the company (assertSameCompany)', async () => {
      const userOther = { ...mockUser, companyId: 'other-company' };
      (prisma.company.findFirst as jest.Mock).mockResolvedValue(mockCompany);
      await expect(service.findOne('company-1', userOther)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('update', () => {
    it('should update company if user is ADMIN and belongs to it', async () => {
      const user = { ...mockUser, companyId: 'company-1' };
      const updateDto = { name: 'Updated Name' };
      (prisma.company.findFirst as jest.Mock).mockResolvedValue(mockCompany);
      (prisma.company.update as jest.Mock).mockResolvedValue({
        ...mockCompany,
        ...updateDto,
      });

      const result = await service.update('company-1', updateDto, user);
      expect(result).toMatchObject(updateDto);
    });

    it('should throw NotFoundException if company not found', async () => {
      (prisma.company.findFirst as jest.Mock).mockResolvedValue(null);
      await expect(
        service.update('unknown', {}, { ...mockUser, companyId: 'company-1' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException if user not in same company', async () => {
      const user = { ...mockUser, companyId: 'other' };
      (prisma.company.findFirst as jest.Mock).mockResolvedValue(mockCompany);
      await expect(service.update('company-1', {}, user)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('findAll', () => {
    it('should return paginated list of non-deleted companies', async () => {
      const items = [mockCompany, { ...mockCompany, id: 'company-2' }];
      (prisma.company.findMany as jest.Mock).mockResolvedValue(items);
      (prisma.company.count as jest.Mock).mockResolvedValue(2);

      const result = await service.findAll(1, 10);
      expect(result.items).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
      expect(result.totalPages).toBe(1);
    });

    it('should apply filters correctly', async () => {
      (prisma.company.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.company.count as jest.Mock).mockResolvedValue(0);

      await service.findAll(1, 10, { name: 'Test', businessSector: 'Tech' });
      expect(prisma.company.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            deletedAt: null,
            name: { contains: 'Test', mode: 'insensitive' },
            businessSector: { contains: 'Tech', mode: 'insensitive' },
          },
        }),
      );
    });
  });
});
