import { Module } from '@nestjs/common';
import { CampagnesController } from './campagnes.controller';
import { CampagnesService } from './campagnes.service';
import { PrismaModule } from '../prisma/prisma.module';
import { BillingModule } from '../billing/billing.module';

@Module({
  imports: [PrismaModule, BillingModule],
  controllers: [CampagnesController],
  providers: [CampagnesService],
})
export class CampagnesModule {}
