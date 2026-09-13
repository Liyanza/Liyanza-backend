import { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types';
import request from 'supertest';
import {
  createTestApp,
  registerAndOnboardAdmin,
  OnboardedAdmin,
} from './utils/test-app';

/**
 * Parcours critique #1 (BACK-402) : inscription -> connexion -> création
 * d'entreprise -> campagne -> canaux -> planning -> lancement.
 *
 * Couvre le chemin complet identifié dans `docs/BACKLOG_REORIENTE.md`
 * (Phase 4, BACK-402) plutôt qu'un test unitaire isolé par module : c'est la
 * séquence réelle qu'un ADMIN suit pour faire vivre une campagne RADIO, y
 * compris les deux gardes qui empêchent un lancement prématuré
 * (`CampagnesService.validateCampaignComplete`).
 */
describe('Parcours critique : campagne -> canaux -> planning -> lancement (e2e)', () => {
  let app: INestApplication<App>;
  let admin: OnboardedAdmin;
  let campaignId: string;
  let channelId: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await registerAndOnboardAdmin(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('crée une campagne RADIO en statut DRAFT', async () => {
    const now = Date.now();
    const res = await request(app.getHttpServer())
      .post('/campagnes')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({
        name: 'Campagne E2E lancement radio',
        startDate: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
        endDate: new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString(),
        plannedBudget: 500_000,
        objective: 'Vérifier le parcours critique de lancement',
        type: 'RADIO',
      })
      .expect(201);

    expect(res.body.status).toBe('DRAFT');
    expect(res.body.type).toBe('RADIO');
    campaignId = res.body.id;
  });

  it('refuse le lancement (DRAFT -> PLANNED) sans aucun canal', async () => {
    const res = await request(app.getHttpServer())
      .post(`/campagnes/${campaignId}/lancer`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ status: 'PLANNED' })
      .expect(400);

    expect(res.body.message).toMatch(/advertising channel/i);
  });

  it('associe un canal radio à la campagne', async () => {
    const res = await request(app.getHttpServer())
      .post(`/campagnes/${campaignId}/canaux`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ channels: [{ radio: true, poster: false, flyer: false }] })
      .expect(201);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    channelId = res.body[0].id;
  });

  it('refuse toujours le lancement sans planning (canal seul insuffisant)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/campagnes/${campaignId}/lancer`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ status: 'PLANNED' })
      .expect(400);

    expect(res.body.message).toMatch(/scheduled broadcast/i);
  });

  it('crée le planning de diffusion', async () => {
    const scheduledAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    const res = await request(app.getHttpServer())
      .post(`/campagnes/${campaignId}/planning`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({
        broadcasts: [
          {
            mediaType: 'RADIO',
            scheduledAt: scheduledAt.toISOString(),
            duration: 30,
            channelId,
          },
        ],
      })
      .expect(201);

    expect(res.body).toHaveLength(1);
    expect(res.body[0].status).toBe('PLANNED');
  });

  it('lance la campagne DRAFT -> PLANNED une fois canaux et planning en place', async () => {
    const res = await request(app.getHttpServer())
      .post(`/campagnes/${campaignId}/lancer`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ status: 'PLANNED' })
      .expect(200);

    expect(res.body.status).toBe('PLANNED');
  });

  it('poursuit le lancement PLANNED -> IN_PROGRESS', async () => {
    const res = await request(app.getHttpServer())
      .post(`/campagnes/${campaignId}/lancer`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ status: 'IN_PROGRESS' })
      .expect(200);

    expect(res.body.status).toBe('IN_PROGRESS');
  });

  it('rejette une transition invalide (IN_PROGRESS -> PLANNED)', async () => {
    await request(app.getHttpServer())
      .post(`/campagnes/${campaignId}/lancer`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ status: 'PLANNED' })
      .expect(400);
  });

  it('GET /campagnes/:id reflète le statut IN_PROGRESS', async () => {
    const res = await request(app.getHttpServer())
      .get(`/campagnes/${campaignId}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    expect(res.body.status).toBe('IN_PROGRESS');
  });

  it('isolation multi-tenant : une autre entreprise reçoit 404, jamais 403', async () => {
    const otherAdmin = await registerAndOnboardAdmin(app);

    await request(app.getHttpServer())
      .get(`/campagnes/${campaignId}`)
      .set('Authorization', `Bearer ${otherAdmin.accessToken}`)
      .expect(404);
  });

  it('rejette toute requête sans authentification (401)', async () => {
    await request(app.getHttpServer())
      .get(`/campagnes/${campaignId}`)
      .expect(401);
  });
});
