import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import type { App } from 'supertest/types';
import request from 'supertest';
import { randomBytes } from 'crypto';
import { AppModule } from '../../src/app.module';

/**
 * Construit l'application Nest pour les tests E2E (BACK-402), à partir du
 * VRAI `AppModule` (aucun mock de module métier) — seuls les `ValidationPipe`
 * de `src/main.ts` sont répliqués ici : indispensables pour tester les rejets
 * 400 (`whitelist`/`forbidNonWhitelisted`). `helmet()`/CORS sont omis : ce
 * sont des préoccupations HTTP transverses déjà couvertes par ailleurs, pas
 * des parcours métier.
 */
export async function createTestApp(): Promise<INestApplication<App>> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  await app.init();
  return app;
}

/** Suffixe imprévisible pour ne jamais collisionner entre deux runs/specs. */
export function uniqueSuffix(): string {
  return randomBytes(6).toString('hex');
}

export interface OnboardedAdmin {
  accessToken: string;
  refreshToken: string;
  userId: string;
  companyId: string;
  email: string;
}

/**
 * Reproduit le SEUL parcours d'onboarding réel de l'API (il n'existe pas de
 * route "créer un compte ADMIN" directe) :
 *   1. `POST /auth/register` — crée toujours un utilisateur sans entreprise,
 *      rôle le plus bas (`COMMUNITY_MANAGER`), jamais choisi par le client.
 *   2. `POST /auth/login` — émet un premier couple de tokens, dont l'access
 *      token porte encore `companyId: null`.
 *   3. `POST /entreprises` — crée l'entreprise et promeut l'appelant en
 *      ADMIN, mais UNIQUEMENT en base (`EntreprisesService.create`) — le JWT
 *      déjà émis n'est pas retouché rétroactivement.
 *   4. `POST /auth/refresh` — seul point qui relit rôle/`companyId` depuis
 *      la base (`AuthService.refresh`, correctif audit anti-privilège-figé) :
 *      indispensable pour obtenir un access token utilisable sur les routes
 *      scopées entreprise.
 */
export async function registerAndOnboardAdmin(
  app: INestApplication<App>,
): Promise<OnboardedAdmin> {
  const suffix = uniqueSuffix();
  const email = `e2e-${suffix}@liyanza-test.local`;
  const password = 'E2eTest#Passw0rd!';

  await request(app.getHttpServer())
    .post('/auth/register')
    .send({
      email,
      password,
      firstName: 'E2E',
      lastName: 'Admin',
      phone: '+237600000099',
    })
    .expect(201);

  const loginRes = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password })
    .expect(201);

  const userId: string = loginRes.body.user.id;

  await request(app.getHttpServer())
    .post('/entreprises')
    .set('Authorization', `Bearer ${loginRes.body.accessToken}`)
    .send({
      name: `Entreprise E2E ${suffix}`,
      businessSector: 'Test',
      address: 'Douala, Cameroun',
    })
    .expect(201);

  const refreshRes = await request(app.getHttpServer())
    .post('/auth/refresh')
    .send({ refreshToken: loginRes.body.refreshToken })
    .expect(201);

  const accessToken: string = refreshRes.body.accessToken;
  const payload = decodeJwtPayload<{ companyId: string }>(accessToken);

  return {
    accessToken,
    refreshToken: refreshRes.body.refreshToken,
    userId,
    companyId: payload.companyId,
    email,
  };
}

/**
 * Décode (sans vérifier la signature) le payload d'un JWT émis par l'API
 * elle-même dans le même test — inutile de revalider une signature qu'on
 * vient de produire soi-même, seul l'accès au claim `companyId` est requis.
 */
function decodeJwtPayload<T>(token: string): T {
  const [, payloadSegment] = token.split('.');
  return JSON.parse(
    Buffer.from(payloadSegment, 'base64').toString('utf8'),
  ) as T;
}
