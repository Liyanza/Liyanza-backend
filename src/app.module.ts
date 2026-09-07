import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { validate } from './config/env.validation';
import appConfig from './config/app.config';
import databaseConfig from './config/database.config';
import jwtConfig from './config/jwt.config';
import redisConfig from './config/redis.config';
import corsConfig from './config/cors.config';
import { LoggerModule } from './modules/logger/logger.module';
import { HealthModule } from './modules/health/health.module';
import { PrismaModule } from './modules/prisma/prisma.module';
import { RedisModule } from './modules/redis/redis.module';
import { AuthModule } from './modules/auth/auth.module';
import { EntreprisesModule } from './modules/entreprises/entreprises.module';
import { UsersModule } from './modules/users/users.module';
import { CampagnesModule } from './modules/campagnes/campagnes.module';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from './modules/auth/guards/roles.guard';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { CanauxModule } from './modules/canaux/canaux.module';
import { DiffusionsModule } from './modules/diffusions/diffusions.module';
import { PrestationsModule } from './modules/prestations/prestations.module';
import { StatistiquesModule } from './modules/statistiques/statistiques.module';
import { AssistantIAModule } from './modules/assistant-ia/assistant-ia.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { QueueModule } from './modules/queue/queue.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, databaseConfig, jwtConfig, redisConfig, corsConfig],
      validate,
    }),
    // SÉCURITÉ (correctif audit — majeur) : rate limiting global anti
    // brute-force / credential stuffing. Limite par défaut : 20 requêtes /
    // minute / IP sur l'ensemble de l'API. Des limites plus strictes sont
    // appliquées spécifiquement sur `/auth/login`, `/auth/register` et
    // `/auth/refresh` via `@Throttle(...)` (voir `AuthController`).
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60_000,
        limit: 20,
      },
    ]),
    LoggerModule,
    HealthModule,
    PrismaModule,
    RedisModule,
    AuthModule,
    EntreprisesModule,
    UsersModule,
    CampagnesModule,
    CanauxModule,
    DiffusionsModule,
    PrestationsModule,
    StatistiquesModule,
    AssistantIAModule,
    NotificationsModule,
    QueueModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    RequestIdMiddleware,
    {
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
    // L'ordre des APP_GUARD est important : Nest les exécute dans l'ordre
    // de déclaration. ThrottlerGuard tourne en premier — y compris sur les
    // routes `@Public()` (login/register), qui sont justement les cibles du
    // brute force — puis JwtAuthGuard, puis RolesGuard.
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
