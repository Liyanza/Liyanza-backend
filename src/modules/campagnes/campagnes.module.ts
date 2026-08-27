import { Module } from '@nestjs/common';
import { CampagnesController } from './campagnes.controller';
import { CampagnesService } from './campagnes.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [CampagnesController],
  providers: [CampagnesService],
})
export class CampagnesModule {}
