import { Module } from '@nestjs/common';
import { DiffusionsController } from './diffusions.controller';
import { DiffusionsService } from './diffusions.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [DiffusionsController],
  providers: [DiffusionsService],
})
export class DiffusionsModule {}
