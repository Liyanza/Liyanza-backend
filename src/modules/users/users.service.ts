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

  private generateTemporaryPassword(): string {
    return randomBytes(8).toString('hex');
  }

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
    if (process.env.NODE_ENV !== 'production') {
      console.log(
        `[UsersService] Temporary password for ${user.email}: ${plainPassword}`,
      );
    }

    // Exclude password from the response
    const result = {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      role: user.role,
      companyId: user.companyId,
      createdAt: user.createdAt,
      deactivatedAt: user.deactivatedAt,
    };
    return result;
  }

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
