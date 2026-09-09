import { Module } from '@nestjs/common';
import { MonitoringController } from './monitoring.controller';
import { MonitoringService } from './monitoring.service';
import { InternalTokenGuard } from './guards/internal-token.guard';
import { PrismaModule } from '../prisma/prisma.module';
import { DiffusionsModule } from '../diffusions/diffusions.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [PrismaModule, DiffusionsModule, NotificationsModule],
  controllers: [MonitoringController],
  providers: [MonitoringService, InternalTokenGuard],
})
export class MonitoringModule {}
