import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
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
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  // Utiliser notre logger personnalisé
  const logger = app.get(LoggerService);
  app.useLogger(logger);

  const configService = app.get(ConfigService);
  const nodeEnv = configService.get<string>('app.nodeEnv');
  const isProduction = nodeEnv === 'production';

  // SÉCURITÉ (correctif audit — majeur) : sans `trust proxy`, Express résout
  // `req.ip` à l'adresse du dernier saut réseau. Derrière un ALB AWS (cf.
  // README, déploiement ECS Fargate), c'est donc l'IP du load balancer qui
  // est vue pour TOUTES les requêtes. `ThrottlerGuard` utilisant `req.ip`
  // comme clé de comptage, l'intégralité du trafic de la plateforme
  // partageait un unique compteur : le rate limiting anti brute-force sur
  // /auth/login devenait à la fois inopérant (un attaquant se noie dans le
  // trafic légitime) et un vecteur de déni de service (un attaquant seul
  // consomme le quota de tous les utilisateurs).
  //
  // La valeur `1` fait confiance à un seul proxy — celui que nous opérons.
  // Ne jamais mettre `true` : cela laisserait n'importe quel client forger
  // son IP via un en-tête `X-Forwarded-For`, et donc contourner le throttler.
  app.set('trust proxy', configService.get<number>('app.trustProxyHops') ?? 1);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  // En-têtes de sécurité HTTP standards (X-Frame-Options, HSTS,
  // X-Content-Type-Options, CSP de base, etc.)
  app.use(helmet());

  const corsOrigins = configService.get<string[]>('cors.origins') ?? [];

  // Garde-fou dur : impossible de démarrer en production avec un wildcard.
  if (isProduction && corsOrigins.includes('*')) {
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
      // CORRECTIF AUDIT (mineur) : renvoyer une `Error` ici la faisait
      // remonter comme une exception non gérée (500 + message reflétant
      // l'origine appelante). Refuser proprement suffit : le navigateur
      // bloquera la réponse faute d'en-tête `Access-Control-Allow-Origin`.
      callback(null, false);
    },
    credentials: true,
  });

  // CORRECTIF AUDIT (mineur) : `@nestjs/swagger` est une dépendance et les
  // contrôleurs sont annotés (`@ApiTags`, `@ApiOperation`, `@ApiProperty`),
  // mais `SwaggerModule.setup()` n'était jamais appelé : la documentation
  // promise par le README n'a jamais été exposée. On la publie hors
  // production uniquement — exposer le schéma complet de l'API à des
  // utilisateurs non authentifiés facilite la reconnaissance.
  if (!isProduction) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Liyanza API')
      .setDescription(
        'API core de la plateforme Liyanza — marketing intelligent pour les marchés émergents.',
      )
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, document);
    logger.log('📚 Swagger UI available at /docs');
  }

  // CORRECTIF AUDIT (majeur — arrêt non gracieux) : sans cet appel, Nest
  // n'écoute pas SIGTERM. Sur ECS Fargate, le signal envoyé au moment d'un
  // redéploiement ou d'un scale-in tuait le processus sans exécuter les
  // hooks `onModuleDestroy` : requêtes en vol coupées, transactions Prisma
  // interrompues, connexions Postgres et Redis laissées ouvertes côté
  // serveur jusqu'à expiration.
  app.enableShutdownHooks();

  const port = configService.get<number>('app.port') ?? 3000;
  await app.listen(port);
  logger.log(`🚀 Liyanza-backend running on http://localhost:${port}`);
}

bootstrap().catch((err) => {
  console.error('❌ Bootstrap failed:', err);
  process.exit(1);
});
