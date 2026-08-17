import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Modules de domaine à importer dynamiquement en Phase 1+
    // AuthModule,
    // UsersModule,
    // EntreprisesModule,
    // CampagnesModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
