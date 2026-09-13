import { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types';
import request from 'supertest';
import {
  createTestApp,
  registerAndOnboardAdmin,
  OnboardedAdmin,
} from './utils/test-app';

/**
 * Parcours critique #2 (BACK-402) : planning -> constat -> conformité.
 *
 * Couvre `DiffusionsService.applyConstat` (verrou optimiste, idempotence) et
 * `getRapportConformite` (agrégation BROADCASTED/PENDING/MISSED + écart en
 * minutes), avec deux diffusions planifiées à des dates différentes pour
 * observer les deux issues sans attendre le passage réel du temps.
 */
describe('Parcours critique : planning -> constat -> rapport de conformité (e2e)', () => {
  let app: INestApplication<App>;
  let admin: OnboardedAdmin;
  let campaignId: string;
  let pastBroadcastId: string;
  let futureBroadcastId: string;
  const pastScheduledAt = new Date(Date.now() - 2 * 60 * 60 * 1000); // -2h
  const futureScheduledAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000); // +2j

  beforeAll(async () => {
    app = await createTestApp();
    admin = await registerAndOnboardAdmin(app);

    const campaignRes = await request(app.getHttpServer())
      .post('/campagnes')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({
        name: 'Campagne E2E conformité',
        startDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
        endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        plannedBudget: 300_000,
        objective: 'Vérifier le parcours critique constat/conformité',
        type: 'RADIO',
      })
      .expect(201);
    campaignId = campaignRes.body.id;

    const channelRes = await request(app.getHttpServer())
      .post(`/campagnes/${campaignId}/canaux`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ channels: [{ radio: true, poster: false, flyer: false }] })
      .expect(201);
    const channelId: string = channelRes.body[0].id;

    const scheduleRes = await request(app.getHttpServer())
      .post(`/campagnes/${campaignId}/planning`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({
        broadcasts: [
          {
            mediaType: 'RADIO',
            scheduledAt: pastScheduledAt.toISOString(),
            duration: 30,
            channelId,
          },
          {
            mediaType: 'RADIO',
            scheduledAt: futureScheduledAt.toISOString(),
            duration: 30,
            channelId,
          },
        ],
      })
      .expect(201);

    const [pastBroadcast, futureBroadcast] = scheduleRes.body as Array<{
      id: string;
      scheduledAt: string;
    }>;
    // L'ordre de création suit l'ordre du tableau envoyé — vérifié par
    // `scheduledAt` plutôt que supposé, pour ne pas dépendre d'un détail
    // d'implémentation de `$transaction`.
    if (
      new Date(pastBroadcast.scheduledAt) <
      new Date(futureBroadcast.scheduledAt)
    ) {
      pastBroadcastId = pastBroadcast.id;
      futureBroadcastId = futureBroadcast.id;
    } else {
      pastBroadcastId = futureBroadcast.id;
      futureBroadcastId = pastBroadcast.id;
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('enregistre le constat de la diffusion passée avec un écart de 40 minutes', async () => {
    const actualBroadcastAt = new Date(
      pastScheduledAt.getTime() + 40 * 60 * 1000,
    );

    const res = await request(app.getHttpServer())
      .patch(`/diffusions/${pastBroadcastId}/constat`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({
        actualBroadcastAt: actualBroadcastAt.toISOString(),
        audioProof: 'proof-e2e-base64',
      })
      .expect(200);

    expect(res.body.status).toBe('BROADCASTED');
    expect(res.body.audioProof).toBe('proof-e2e-base64');
  });

  it('rejette un second constat sur la même diffusion (idempotence, 409)', async () => {
    await request(app.getHttpServer())
      .patch(`/diffusions/${pastBroadcastId}/constat`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ actualBroadcastAt: new Date().toISOString() })
      .expect(409);
  });

  it('404 sur le constat d’une diffusion inconnue', async () => {
    await request(app.getHttpServer())
      .patch('/diffusions/clunknownbroadcastid00/constat')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ audioProof: 'x' })
      .expect(404);
  });

  it('le rapport de conformité reflète BROADCASTED (écart 40 min) et PENDING', async () => {
    const res = await request(app.getHttpServer())
      .get(`/campagnes/${campaignId}/rapport-conformite`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    expect(res.body.campagneId).toBe(campaignId);
    const items: Array<{
      diffusionId: string;
      status: string;
      ecartMinutes: number | null;
    }> = res.body.diffusions;

    const pastItem = items.find((i) => i.diffusionId === pastBroadcastId);
    const futureItem = items.find((i) => i.diffusionId === futureBroadcastId);

    expect(pastItem?.status).toBe('BROADCASTED');
    expect(pastItem?.ecartMinutes).toBe(40);
    expect(futureItem?.status).toBe('PENDING');
    expect(futureItem?.ecartMinutes).toBeNull();
  });

  it('isolation multi-tenant : 404 sur le constat pour une autre entreprise', async () => {
    const otherAdmin = await registerAndOnboardAdmin(app);

    await request(app.getHttpServer())
      .patch(`/diffusions/${futureBroadcastId}/constat`)
      .set('Authorization', `Bearer ${otherAdmin.accessToken}`)
      .send({ audioProof: 'intrusion' })
      .expect(404);
  });

  it('isolation multi-tenant : 404 sur le rapport de conformité pour une autre entreprise', async () => {
    const otherAdmin = await registerAndOnboardAdmin(app);

    await request(app.getHttpServer())
      .get(`/campagnes/${campaignId}/rapport-conformite`)
      .set('Authorization', `Bearer ${otherAdmin.accessToken}`)
      .expect(404);
  });
});
