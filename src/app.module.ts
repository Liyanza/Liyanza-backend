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
import { RedisThrottlerStorage } from './common/throttler/redis-throttler.storage';
import { RedisService } from './modules/redis/redis.service';
import { CanauxModule } from './modules/canaux/canaux.module';
import { DiffusionsModule } from './modules/diffusions/diffusions.module';
import { PrestationsModule } from './modules/prestations/prestations.module';
import { StatistiquesModule } from './modules/statistiques/statistiques.module';
import { AssistantIAModule } from './modules/assistant-ia/assistant-ia.module';
import { SimulationsModule } from './modules/simulations/simulations.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { QueueModule } from './modules/queue/queue.module';
import { TasksModule } from './modules/tasks/tasks.module';
import { QrCodeModule } from './modules/qr-code/qr-code.module';
import { MonitoringModule } from './modules/monitoring/monitoring.module';
import { MediaModule } from './modules/media/media.module';

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
    //
    // CORRECTIF AUDIT (majeur) : le stockage par défaut est EN MÉMOIRE, donc
    // local à chaque instance. Derrière l'ALB de l'architecture cible (ECS
    // Fargate, N tâches), la limite réelle était de N × la limite annoncée et
    // repartait de zéro à chaque redéploiement. On bascule sur un stockage
    // Redis partagé — voir `RedisThrottlerStorage`.
    ThrottlerModule.forRootAsync({
      imports: [RedisModule],
      inject: [RedisService],
      useFactory: (redis: RedisService) => ({
        throttlers: [{ name: 'default', ttl: 60_000, limit: 20 }],
        storage: new RedisThrottlerStorage(redis),
      }),
    }),
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
    SimulationsModule,
    NotificationsModule,
    QueueModule,
    TasksModule,
    QrCodeModule,
    MediaModule,
    MonitoringModule,
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
