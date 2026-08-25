import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { RequestHandler } from 'express';
import * as helmetModule from 'helmet';
import { AppModule } from './app.module';
import { LoggerService } from './modules/logger/logger.service';

// Compat CJS/ESM : selon la résolution de modules, helmet peut être exposé
// via `default` ou directement comme fonction. On type explicitement le
// résultat pour éviter tout `any` implicite (et donc no-unsafe-call).
const helmet: () => RequestHandler =
  (helmetModule as unknown as { default?: () => RequestHandler }).default ??
  (helmetModule as unknown as () => RequestHandler);

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  // Utiliser notre logger personnalisé
  const logger = app.get(LoggerService);
  app.useLogger(logger);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // En-têtes de sécurité HTTP standards (X-Frame-Options, HSTS,
  // X-Content-Type-Options, CSP de base, etc.)
  app.use(helmet());

  const configService = app.get(ConfigService);
  const nodeEnv = configService.get<string>('app.nodeEnv');
  const corsOrigins = configService.get<string[]>('cors.origins') ?? [];

  // Garde-fou dur : impossible de démarrer en production avec un wildcard.
  if (nodeEnv === 'production' && corsOrigins.includes('*')) {
    throw new Error(
      'CORS_ORIGINS should never contain a wildcard "*" in production.',
    );
  }

  if (corsOrigins.length === 0) {
    logger.warn(
      'CORS_ORIGINS is empty: no cross-site origin will be able to call this API.',
    );
  }

  app.enableCors({
    origin: (
      requestOrigin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      // Pas d'en-tête Origin (curl, apps mobiles natives, health checks
      // server-to-server) : on laisse passer, CORS ne s'applique qu'au
      // navigateur.
      if (!requestOrigin || corsOrigins.includes(requestOrigin)) {
        callback(null, true);
        return;
      }
      callback(
        new Error(`Origin not authorized by CORS policy: ${requestOrigin}`),
      );
    },
    credentials: true,
  });

  const port = configService.get<number>('app.port') ?? 3000;
  await app.listen(port);
  logger.log(`🚀 Liyanza-backend running on http://localhost:${port}`);
}

bootstrap().catch((err) => {
  console.error('❌ Bootstrap failed:', err);
  process.exit(1);
});
