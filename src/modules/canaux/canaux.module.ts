import { Module } from '@nestjs/common';
import { CanauxController } from './canaux.controller';
import { CanauxService } from './canaux.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [CanauxController],
  providers: [CanauxService],
})
export class CanauxModule {}
