import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateEntrepriseDto } from './dto/create-entreprise.dto';
import { UpdateEntrepriseDto } from './dto/update-entreprise.dto';
import { assertSameCompany } from '../auth/utils/company-scope.util';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Role } from '@prisma/client';

@Injectable()
export class EntreprisesService {
  constructor(private prisma: PrismaService) {}

  /**
   * Creates a new company and assigns the current user as its ADMIN.
   * The user must not already belong to another company.
   */
  async create(createDto: CreateEntrepriseDto, user: AuthenticatedUser) {
    // A user can only belong to one company
    if (user.companyId) {
      throw new ConflictException(
        'You already belong to a company. You cannot create another one.',
      );
    }

    // Create the company
    const company = await this.prisma.company.create({
      data: {
        name: createDto.name,
        businessSector: createDto.businessSector,
        address: createDto.address,
        // deletedAt defaults to null
      },
    });

    // Update the user: link to the new company and promote to ADMIN
    await this.prisma.user.update({
      where: { id: user.userId },
      data: {
        companyId: company.id,
        role: Role.ADMIN,
      },
    });

    return company;
  }

  /**
   * Retrieves a company by ID (excluding soft-deleted ones).
   * Ensures the current user belongs to that company.
   */
  async findOne(id: string, user: AuthenticatedUser) {
    const company = await this.prisma.company.findFirst({
      where: {
        id,
        deletedAt: null,
      },
    });

    if (!company) {
      throw new NotFoundException('Company not found.');
    }

    assertSameCompany(user, company.id, 'Company');

    return company;
  }

  /**
   * Updates a company. Only ADMIN users of that company are allowed.
   * (The @Roles(ADMIN) guard is applied at the controller level.)
   */
  async update(
    id: string,
    updateDto: UpdateEntrepriseDto,
    user: AuthenticatedUser,
  ) {
    // Check that the company exists and is not soft-deleted
    const existing = await this.prisma.company.findFirst({
      where: { id, deletedAt: null },
    });

    if (!existing) {
      throw new NotFoundException('Company not found.');
    }

    // Multi-tenant isolation check
    assertSameCompany(user, existing.id, 'Company');

    // Perform the update
    return this.prisma.company.update({
      where: { id },
      data: {
        ...(updateDto.name && { name: updateDto.name }),
        ...(updateDto.businessSector && {
          businessSector: updateDto.businessSector,
        }),
        ...(updateDto.address && { address: updateDto.address }),
      },
    });
  }

  /**
   * Returns a paginated and filtered list of companies (soft-deleted excluded).
   * Currently restricted to ADMIN users (future SUPER_ADMIN role).
   */
  async findAll(
    page: number = 1,
    limit: number = 10,
    filters?: { name?: string; businessSector?: string },
  ) {
    const skip = (page - 1) * limit;
    const where: any = { deletedAt: null };

    if (filters?.name) {
      where.name = { contains: filters.name, mode: 'insensitive' };
    }
    if (filters?.businessSector) {
      where.businessSector = {
        contains: filters.businessSector,
        mode: 'insensitive',
      };
    }

    const [items, total] = await Promise.all([
      this.prisma.company.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.company.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }
}
