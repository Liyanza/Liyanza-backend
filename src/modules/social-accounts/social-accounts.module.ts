import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { SocialAccountsController } from './social-accounts.controller';
import { SocialAccountsService } from './social-accounts.service';
import { SocialAccountsSchedulerService } from './social-accounts-scheduler.service';
import { SocialMetricsSyncProcessor } from './processors/social-metrics-sync.processor';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';
import { QueueModule } from '../queue/queue.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { MetaGraphClient } from './clients/meta-graph.client';
import { SOCIAL_PLATFORM_CLIENT_TOKEN } from './clients/social-platform-client.interface';

@Module({
  imports: [
    PrismaModule,
    RedisModule,
    QueueModule,
    NotificationsModule,
    HttpModule.register({ timeout: 10_000 }),
  ],
  controllers: [SocialAccountsController],
  providers: [
    SocialAccountsService,
    SocialAccountsSchedulerService,
    SocialMetricsSyncProcessor,
    {
      provide: SOCIAL_PLATFORM_CLIENT_TOKEN,
      useClass: MetaGraphClient,
    },
  ],
  exports: [SocialAccountsService],
})
export class SocialAccountsModule {}
