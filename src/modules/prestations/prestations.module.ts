import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import type { StringValue } from 'ms';
import { PrestationsController } from './prestations.controller';
import { PrestationsService } from './prestations.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [
    PrismaModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('jwt.validationSecret'),
        signOptions: {
          expiresIn: (configService.get<string>('jwt.validationExpiration') ??
            '7d') as StringValue,
        },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [PrestationsController],
  providers: [PrestationsService],
})
export class PrestationsModule {}
