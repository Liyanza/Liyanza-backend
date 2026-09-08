import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import type { StringValue } from 'ms';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { CompanyScopeGuard } from './guards/company-scope.guard';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [
    PassportModule,
    // CORRECTIF AUDIT (mineur — typage & duplication de configuration) :
    // le `as any` masquait l'incompatibilité de type entre `string` et le
    // type `StringValue` attendu par `jsonwebtoken`, désactivant au passage
    // toute vérification sur l'objet `signOptions`. On type explicitement, et
    // on consomme le namespace `jwt` (src/config/jwt.config.ts) qui était
    // jusqu'ici chargé mais jamais lu — deux sources de vérité coexistaient.
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('jwt.secret'),
        signOptions: {
          expiresIn: (configService.get<string>('jwt.accessExpiration') ??
            '15m') as StringValue,
        },
      }),
      inject: [ConfigService],
    }),
    PrismaModule,
    RedisModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtStrategy,
    JwtAuthGuard,
    RolesGuard,
    CompanyScopeGuard,
  ],
  exports: [
    AuthService,
    JwtAuthGuard,
    RolesGuard,
    CompanyScopeGuard,
    JwtModule,
  ],
})
export class AuthModule {}
