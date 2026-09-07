import {
  Injectable,
  UnauthorizedException,
  ConflictException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import * as bcrypt from 'bcrypt';
import { Role } from '@prisma/client';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private redisService: RedisService,
    private configService: ConfigService,
  ) {}

  async register(dto: RegisterDto) {
    const existingUser = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (existingUser) {
      throw new ConflictException('This email is already in use.');
    }

    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(dto.password, saltRounds);

    // SÉCURITÉ (correctif audit — faille critique) : le rôle et l'entreprise
    // ne sont JAMAIS déterminés à partir du payload client. Une inscription
    // publique crée toujours un utilisateur "orphelin" (sans entreprise) au
    // rôle le plus bas du domaine. Le rattachement à une entreprise se fait
    // ensuite exclusivement via `POST /entreprises` (création + auto-promotion
    // ADMIN de la NOUVELLE entreprise) ou via une invitation d'un ADMIN déjà
    // légitime (`UsersService.createSubAccount`).
    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        password: hashedPassword,
        firstName: dto.firstName,
        lastName: dto.lastName,
        phone: dto.phone,
        role: Role.COMMUNITY_MANAGER,
        companyId: null,
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { password, ...result } = user;
    return result;
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid credentials.');
    }

    if (user.deactivatedAt) {
      throw new UnauthorizedException('Invalid credentials.');
    }

    const isPasswordValid = await bcrypt.compare(dto.password, user.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials.');
    }

    const payload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      companyId: user.companyId,
    };
    const accessToken = this.jwtService.sign(payload, {
      expiresIn: this.configService.get('JWT_ACCESS_EXPIRATION') || '15m',
    });
    const refreshToken = this.jwtService.sign(payload, {
      expiresIn: this.configService.get('JWT_REFRESH_EXPIRATION') || '7d',
    });

    // Décoder le refresh token pour obtenir son expiration
    const decoded = this.jwtService.decode(refreshToken);
    let ttl = 7 * 24 * 60 * 60; // fallback: 7 jours en secondes
    if (
      decoded &&
      typeof decoded === 'object' &&
      'exp' in decoded &&
      typeof decoded.exp === 'number'
    ) {
      ttl = decoded.exp - Math.floor(Date.now() / 1000);
    }
    await this.redisService.set(`refresh:${user.id}`, refreshToken, ttl);

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
      },
    };
  }

  async refresh(refreshToken: string) {
    try {
      const payload = this.jwtService.verify(refreshToken);
      const userId = payload.sub;

      // Verify user still exists and is not deactivated
      const user = await this.prisma.user.findUnique({ where: { id: userId } });
      if (!user || user.deactivatedAt) {
        throw new UnauthorizedException('Invalid refresh token.');
      }

      const storedToken = await this.redisService.get(`refresh:${userId}`);
      if (storedToken !== refreshToken) {
        throw new UnauthorizedException('Invalid refresh token.');
      }

      const newPayload = {
        sub: userId,
        email: payload.email,
        role: payload.role,
        companyId: payload.companyId,
      };
      const newAccessToken = this.jwtService.sign(newPayload, {
        expiresIn: this.configService.get('JWT_ACCESS_EXPIRATION') || '15m',
      });

      return { accessToken: newAccessToken };
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token.');
    }
  }

  async logout(userId: string) {
    await this.redisService.del(`refresh:${userId}`);
    return { success: true };
  }
}
