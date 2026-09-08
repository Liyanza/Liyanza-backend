/* eslint-disable @typescript-eslint/unbound-method */
/* eslint-disable @typescript-eslint/no-unsafe-argument */

import { Test, TestingModule } from '@nestjs/testing';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
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

  /**
   * Client transactionnel simulé, distinct de `prisma` : si le service
   * régresse et réutilise `this.prisma` à l'intérieur du callback plutôt que
   * le `tx` reçu, les assertions ci-dessous échoueront — c'est précisément le
   * défaut d'atomicité que le correctif d'audit vise à empêcher.
   */
  let txClient: {
    company: { create: jest.Mock };
    user: { updateMany: jest.Mock };
  };

  beforeEach(async () => {
    txClient = {
      company: { create: jest.fn() },
      user: { updateMany: jest.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EntreprisesService,
        {
          provide: PrismaService,
          useValue: {
            // CORRECTIF AUDIT : la création d'entreprise + promotion ADMIN
            // du créateur s'exécute désormais dans une transaction. Mock
            // callback-style fidèle au comportement réel de Prisma : le
            // callback reçoit un client transactionnel `tx` distinct.
            $transaction: jest.fn((cb: (tx: unknown) => unknown) =>
              cb(txClient),
            ),
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

      txClient.company.create.mockResolvedValue({ ...mockCompany, ...dto });
      txClient.user.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.create(dto, user);

      expect(result).toMatchObject(dto);
      // Le rattachement est conditionné à `companyId: null` : c'est le verrou
      // qui empêche deux requêtes concurrentes de créer deux entreprises.
      expect(txClient.user.updateMany).toHaveBeenCalledWith({
        where: { id: user.userId, companyId: null },
        data: { companyId: mockCompany.id, role: Role.ADMIN },
      });
    });

    // RÉGRESSION (race condition) : si l'utilisateur a été rattaché à une
    // entreprise entre-temps, la transaction doit être annulée — sans quoi
    // une entreprise orpheline, sans aucun administrateur, reste en base.
    it('should roll back when the user was linked to a company concurrently', async () => {
      const dto = {
        name: 'New Co',
        businessSector: 'Agri',
        address: 'Yaoundé',
      };

      txClient.company.create.mockResolvedValue(mockCompany);
      txClient.user.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.create(dto, { ...mockUser, companyId: null }),
      ).rejects.toThrow(ConflictException);
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
    const user = { ...mockUser, companyId: 'company-1' };

    it('should throw ForbiddenException if the caller has no company', async () => {
      await expect(
        service.findAll({ ...mockUser, companyId: null }, 1, 10),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should return only the caller company, scoped by id (security fix)', async () => {
      const items = [mockCompany];
      (prisma.company.findMany as jest.Mock).mockResolvedValue(items);
      (prisma.company.count as jest.Mock).mockResolvedValue(1);

      const result = await service.findAll(user, 1, 10);
      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(result.totalPages).toBe(1);

      // Régression critique : la requête DOIT toujours filtrer sur
      // l'entreprise de l'appelant, jamais lister toutes les entreprises.
      expect(prisma.company.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            deletedAt: null,
            id: user.companyId,
          }) as unknown,
        }),
      );
    });

    it('should never leak another company even if a "name" filter matches it', async () => {
      // Even if an attacker crafts a filter that would otherwise match a
      // victim company by name, the hard `id: user.companyId` constraint
      // must remain present in the query.
      (prisma.company.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.company.count as jest.Mock).mockResolvedValue(0);

      await service.findAll(user, 1, 10, { name: 'Victim Corp' });

      expect(prisma.company.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: user.companyId,
            name: { contains: 'Victim Corp', mode: 'insensitive' },
          }) as unknown,
        }),
      );
    });
  });
});
