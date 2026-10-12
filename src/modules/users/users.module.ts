import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { QueueModule } from '../queue/queue.module';
import { MailModule } from '../mail/mail.module';
import { BillingModule } from '../billing/billing.module';

@Module({
  imports: [
    PrismaModule,
    NotificationsModule,
    QueueModule,
    MailModule,
    BillingModule,
  ],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
