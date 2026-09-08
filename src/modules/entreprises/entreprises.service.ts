import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateEntrepriseDto } from './dto/create-entreprise.dto';
import { UpdateEntrepriseDto } from './dto/update-entreprise.dto';
import { assertSameCompany } from '../auth/utils/company-scope.util';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Role, Prisma } from '@prisma/client';

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

    // CORRECTIF AUDIT (majeur — atomicité) : la création de l'entreprise et
    // la promotion de son créateur en ADMIN étaient deux écritures séparées,
    // hors transaction. Si la seconde échouait (indisponibilité, contention,
    // redéploiement au mauvais moment), l'entreprise restait créée SANS aucun
    // administrateur et son créateur sans rattachement : un tenant orphelin,
    // définitivement inaccessible et impossible à réparer par l'API — le
    // contrôle `if (user.companyId)` en tête de méthode empêchant l'appelant
    // de retenter l'opération n'est même pas déclenché, mais l'entreprise
    // fantôme demeure en base.
    //
    // CORRECTIF AUDIT (race condition) : le contrôle `user.companyId` porte
    // sur le JWT. Deux requêtes concurrentes du même utilisateur le
    // passaient toutes deux et créaient deux entreprises. On revérifie donc
    // l'appartenance en base, à l'intérieur de la transaction, et l'écriture
    // du rattachement est conditionnée à `companyId: null`.
    return this.prisma.$transaction(async (tx) => {
      const company = await tx.company.create({
        data: {
          name: createDto.name,
          businessSector: createDto.businessSector,
          address: createDto.address,
          // deletedAt defaults to null
        },
      });

      const linked = await tx.user.updateMany({
        where: { id: user.userId, companyId: null },
        data: {
          companyId: company.id,
          role: Role.ADMIN,
        },
      });

      if (linked.count === 0) {
        // L'utilisateur a été rattaché à une entreprise entre-temps : on
        // annule tout, y compris la création ci-dessus.
        throw new ConflictException(
          'You already belong to a company. You cannot create another one.',
        );
      }

      return company;
    });
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
   *
   * SÉCURITÉ (correctif audit — faille critique) : cet endpoint listait
   * auparavant TOUTES les entreprises de la plateforme dès lors que
   * l'appelant avait le rôle `ADMIN`, sans aucune vérification qu'il était
   * bien admin de l'entreprise consultée. Combinée à l'ancienne faille
   * d'inscription (rôle/entreprise choisis par le client), cela permettait
   * à n'importe quel attaquant d'énumérer les `id` de toutes les entreprises
   * puis de les rejoindre.
   *
   * Le rôle `ADMIN` de ce domaine est scopé à une seule entreprise : il n'y a
   * (pour l'instant) aucun rôle plateforme distinct habilité à parcourir
   * l'ensemble des tenants. Cette méthode ne retourne donc jamais que
   * l'entreprise de l'appelant. Si un vrai rôle plateforme (ex: `SUPER_ADMIN`)
   * est introduit un jour, cette restriction devra être explicitement levée
   * pour ce rôle uniquement (voir `assertSameCompanyUnless`).
   */
  async findAll(
    user: AuthenticatedUser,
    page: number = 1,
    limit: number = 10,
    filters?: { name?: string; businessSector?: string },
  ) {
    if (!user.companyId) {
      throw new ForbiddenException(
        'You must belong to a company to list companies.',
      );
    }

    const skip = (page - 1) * limit;
    const where: Prisma.CompanyWhereInput = {
      deletedAt: null,
      id: user.companyId, // ← isolation multi-tenant stricte
    };

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
