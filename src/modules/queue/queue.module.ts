import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BullBoardModule } from '@bull-board/nestjs';
import { ExpressAdapter } from '@bull-board/express';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ConfigService } from '@nestjs/config';
import { QueueService } from './queue.service';
import { QueueAuthMiddleware } from './queue-auth.middleware';

@Module({
  imports: [
    BullModule.forRootAsync({
      useFactory: (configService: ConfigService) => ({
        connection: { url: configService.get<string>('REDIS_URL') },
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: true,
          removeOnFail: false,
        },
      }),
      inject: [ConfigService],
    }),
    BullModule.registerQueue(
      { name: 'notifications' },
      { name: 'ia-simulation' },
      { name: 'monitoring-radio' },
      { name: 'qr-code-scan' },
    ),
    BullBoardModule.forRoot({
      route: '/admin/queues',
      adapter: ExpressAdapter,
    }),
    BullBoardModule.forFeature(
      { name: 'notifications', adapter: BullMQAdapter },
      { name: 'ia-simulation', adapter: BullMQAdapter },
      { name: 'monitoring-radio', adapter: BullMQAdapter },
      { name: 'qr-code-scan', adapter: BullMQAdapter },
    ),
  ],
  providers: [QueueService, QueueAuthMiddleware],
  exports: [QueueService, BullModule],
})
export class QueueModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(QueueAuthMiddleware).forRoutes('admin/queues*');
  }
}
