import { Module } from '@nestjs/common';
import { StatistiquesController } from './statistiques.controller';
import { StatistiquesService } from './statistiques.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [StatistiquesController],
  providers: [StatistiquesService],
  exports: [StatistiquesService],
})
export class StatistiquesModule {}
