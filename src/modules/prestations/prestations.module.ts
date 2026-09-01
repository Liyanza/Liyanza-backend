import { Module } from '@nestjs/common';
import { PrestationsController } from './prestations.controller';
import { PrestationsService } from './prestations.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [PrestationsController],
  providers: [PrestationsService],
})
export class PrestationsModule {}
