import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { CreateSubAccountDto } from './dto/create-sub-account.dto';
import { Role } from '@prisma/client';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  /**
   * Generate a temporary password (16 alphanumeric characters)
   */
  private generateTemporaryPassword(): string {
    return randomBytes(8).toString('hex'); // 16 hex characters
  }

  /**
   * Create a sub‑account for the admin's company.
   * The password is hashed and stored; it is not returned.
   */
  async createSubAccount(dto: CreateSubAccountDto, admin: AuthenticatedUser) {
    if (!admin.companyId) {
      throw new ForbiddenException(
        'You must belong to a company to create a sub‑account.',
      );
    }

    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (existing) {
      throw new ConflictException('This email is already in use.');
    }

    const plainPassword = this.generateTemporaryPassword();
    const hashedPassword = await bcrypt.hash(plainPassword, 10);

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        password: hashedPassword,
        firstName: dto.firstName,
        lastName: dto.lastName,
        phone: dto.phone,
        role: dto.role,
        companyId: admin.companyId,
      },
    });

    // TODO: send temporary password via Notification module (Phase 3)
    // For now, log it in development only
    if (process.env.NODE_ENV !== 'production') {
      console.log(
        `[UsersService] Temporary password for ${user.email}: ${plainPassword}`,
      );
    }

    const { password, ...result } = user;
    return result;
  }

  /**
   * List all users belonging to the admin's company.
   */
  async findAll(admin: AuthenticatedUser) {
    if (!admin.companyId) {
      throw new ForbiddenException(
        'You must belong to a company to list users.',
      );
    }

    return this.prisma.user.findMany({
      where: { companyId: admin.companyId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        role: true,
        companyId: true,
        createdAt: true,
        deactivatedAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Change a user's role.
   * Prevents the admin from changing their own role.
   */
  async updateRole(userId: string, newRole: Role, admin: AuthenticatedUser) {
    if (!admin.companyId) {
      throw new ForbiddenException(
        'You must belong to a company to update a user.',
      );
    }

    if (userId === admin.userId) {
      throw new ForbiddenException('You cannot change your own role.');
    }

    const targetUser = await this.prisma.user.findUnique({
      where: { id: userId },
    });
    if (!targetUser || targetUser.companyId !== admin.companyId) {
      throw new NotFoundException('User not found.');
    }

    return this.prisma.user.update({
      where: { id: userId },
      data: { role: newRole },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        role: true,
        companyId: true,
        createdAt: true,
        deactivatedAt: true,
      },
    });
  }

  /**
   * Deactivate a user account (set deactivatedAt).
   * Allows deactivating own account as well.
   */
  async deactivate(userId: string, admin: AuthenticatedUser) {
    if (!admin.companyId) {
      throw new ForbiddenException(
        'You must belong to a company to deactivate a user.',
      );
    }

    const targetUser = await this.prisma.user.findUnique({
      where: { id: userId },
    });
    if (!targetUser || targetUser.companyId !== admin.companyId) {
      throw new NotFoundException('User not found.');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { deactivatedAt: new Date() },
    });
  }

  /**
   * Get the profile of the authenticated user.
   */
  async getProfile(user: AuthenticatedUser) {
    const dbUser = await this.prisma.user.findUnique({
      where: { id: user.userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        role: true,
        companyId: true,
        createdAt: true,
        deactivatedAt: true,
      },
    });
    if (!dbUser) {
      throw new NotFoundException('User not found.');
    }
    return dbUser;
  }
}
