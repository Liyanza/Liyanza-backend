import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Modules de domaine à importer dynamiquement en Phase 1+
    // AuthModule,
    // UsersModule,
    // EntreprisesModule,
    // CampagnesModule,
  ],
})
export class AppModule {}
