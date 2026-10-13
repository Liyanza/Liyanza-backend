import { ConfigService } from '@nestjs/config';
import { BroadcastStatus, CampaignStatus, CampaignType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DemoService, DEMO_MAX_AGE_MS } from './demo.service';
import { DEMO_USER_EMAIL } from './demo.constants';
import { DAY } from './demo-data';

type Call = { model: string; method: string; args: Record<string, unknown> };

/**
 * Faux client Prisma en mémoire : juste assez d'état (entreprise de démo,
 * comptes) pour rejouer plusieurs remises à zéro, et l'historique de tous
 * les appels pour vérifier le périmètre de chaque suppression.
 */
function createFakePrisma() {
  const calls: Call[] = [];
  const state = {
    company: null as null | { id: string; updatedAt: Date },
    users: new Map<string, { id: string; companyId: string | null }>(),
    locked: true,
  };
  let sequence = 0;

  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_target, method: string) =>
          jest.fn((args: Record<string, unknown> = {}) => {
            calls.push({ model: name, method, args });
            const data = (args.data ?? {}) as Record<string, unknown>;
            const where = (args.where ?? {}) as Record<string, unknown>;

            if (name === 'company') {
              if (method === 'findFirst') return Promise.resolve(state.company);
              if (method === 'create') {
                state.company = {
                  id: 'demo-company',
                  updatedAt: data.updatedAt as Date,
                };
                return Promise.resolve({ id: 'demo-company' });
              }
              if (method === 'update') {
                state.company!.updatedAt = data.updatedAt as Date;
                return Promise.resolve({ id: state.company!.id });
              }
            }
            if (name === 'user') {
              const email = (where.email ?? data.email) as string;
              if (method === 'findUnique') {
                return Promise.resolve(state.users.get(email) ?? null);
              }
              if (method === 'create') {
                const user = {
                  id: `user-${++sequence}`,
                  companyId: data.companyId as string,
                };
                state.users.set(email, user);
                return Promise.resolve({ ...user, role: data.role });
              }
              if (method === 'update') {
                const id = where.id as string;
                const user = [...state.users.values()].find((u) => u.id === id);
                user!.companyId = data.companyId as string;
                return Promise.resolve({ ...user, role: data.role });
              }
            }
            if (method === 'deleteMany' || method === 'createMany') {
              return Promise.resolve({ count: 0 });
            }
            return Promise.resolve({ id: `${name}-${++sequence}`, ...data });
          }),
      },
    );

  const models = new Map<string, unknown>();
  const tx = new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        if (prop === '$queryRaw') {
          return () => Promise.resolve([{ locked: state.locked }]);
        }
        if (!models.has(prop)) models.set(prop, model(prop));
        return models.get(prop);
      },
    },
  ) as Record<string, unknown>;

  const prisma = new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        if (prop === '$transaction') {
          return (fn: (client: unknown) => Promise<unknown>) => fn(tx);
        }
        return tx[prop];
      },
    },
  );

  return { prisma, calls, state };
}

describe('DemoService', () => {
  const now = new Date('2026-10-13T10:00:00.000Z');
  let fake: ReturnType<typeof createFakePrisma>;
  let config: { get: jest.Mock };
  let service: DemoService;

  beforeEach(() => {
    fake = createFakePrisma();
    config = { get: jest.fn().mockReturnValue(undefined) };
    service = new DemoService(
      fake.prisma as unknown as PrismaService,
      config as unknown as ConfigService,
    );
  });

  const callsOf = (model: string, method: string) =>
    fake.calls.filter((c) => c.model === model && c.method === method);

  describe('wipe (critical: never delete non-demo data)', () => {
    it('should scope EVERY delete by the demo company id', async () => {
      await service.reset(now);

      const deletes = fake.calls.filter(
        (c) => c.method === 'deleteMany' || c.method === 'delete',
      );
      expect(deletes.length).toBeGreaterThanOrEqual(20);
      for (const call of deletes) {
        expect(call.method).toBe('deleteMany');
        expect(call.args.where).toBeDefined();
        // Le périmètre de l'entreprise est dans le filtre lui-même, jamais
        // dans une liste d'ids calculée ailleurs.
        expect(JSON.stringify(call.args.where)).toContain('"demo-company"');
      }
      // Rien ne supprime d'entreprise ni d'utilisateur : seulement leurs données.
      expect(callsOf('company', 'deleteMany')).toHaveLength(0);
      expect(callsOf('user', 'deleteMany')).toHaveLength(0);
      expect(callsOf('campaign', 'deleteMany')[0].args.where).toEqual({
        launchedBy: { companyId: 'demo-company' },
      });
    });

    it('should refuse to run without a company id', async () => {
      await expect(service.wipe(fake.prisma as never, '')).rejects.toThrow();
      expect(fake.calls).toHaveLength(0);
    });

    it('should abort (no delete at all) if a demo address belongs to another company', async () => {
      fake.state.users.set(DEMO_USER_EMAIL, {
        id: 'real-user',
        companyId: 'real-company',
      });
      await expect(service.reset(now)).rejects.toThrow(/another company/);
      expect(fake.calls.filter((c) => c.method === 'deleteMany')).toHaveLength(
        0,
      );
      expect(callsOf('user', 'update')).toHaveLength(0);
    });

    it('should do nothing when another instance holds the reset lock', async () => {
      fake.state.locked = false;
      await expect(service.reset(now)).resolves.toBeNull();
      expect(fake.calls).toHaveLength(0);
    });
  });

  describe('reset', () => {
    it('should be idempotent: same company and accounts, same data each time', async () => {
      const first = await service.reset(now);
      const second = await service.reset(new Date(now.getTime() + DAY));

      expect(callsOf('company', 'create')).toHaveLength(1);
      expect(callsOf('company', 'update')).toHaveLength(1);
      expect(callsOf('user', 'create')).toHaveLength(3);
      expect(callsOf('user', 'update')).toHaveLength(3);
      expect(second).toEqual(first);
      expect(first).toMatchObject({
        companyId: 'demo-company',
        campaigns: 5,
        installations: 8,
        proofs: 6,
        members: 3,
      });

      // Les suppressions précèdent toujours les créations de la remise à zéro.
      const firstCampaignCreate = fake.calls.findIndex(
        (c) => c.model === 'campaign' && c.method === 'create',
      );
      const lastWipeBefore = fake.calls
        .slice(0, firstCampaignCreate)
        .filter((c) => c.method === 'deleteMany');
      expect(lastWipeBefore.length).toBeGreaterThanOrEqual(20);
    });

    it('should create accounts without any usable password or social login', async () => {
      await service.reset(now);
      for (const call of callsOf('user', 'create')) {
        expect(call.args.data).toMatchObject({
          password: null,
          googleId: null,
          facebookId: null,
          companyId: 'demo-company',
        });
        expect((call.args.data as { email: string }).email).toMatch(
          /@demo\.kiyanza\.com$/,
        );
      }
      const [company] = callsOf('company', 'create');
      expect(company.args.data).toMatchObject({
        isDemo: true,
        name: 'Brasserie Sawa (démo)',
        // Formule PRO via l'essai, repoussé d'un an à chaque remise à zéro.
        trialEndsAt: new Date(now.getTime() + 365 * DAY),
      });
    });

    it('should build every date relative to the reset time', async () => {
      const later = new Date(now.getTime() + 10 * DAY);
      await service.reset(now);
      const firstRun = callsOf('campaign', 'create').map(
        (c) =>
          c.args.data as { startDate: Date; endDate: Date; status: string },
      );
      const firstBroadcasts = callsOf('broadcast', 'createMany')[0].args
        .data as { scheduledAt: Date; status: BroadcastStatus }[];

      fake.calls.length = 0;
      await service.reset(later);
      const secondRun = callsOf('campaign', 'create').map(
        (c) => c.args.data as { startDate: Date; endDate: Date },
      );
      const secondBroadcasts = callsOf('broadcast', 'createMany')[0].args
        .data as { scheduledAt: Date }[];

      expect(secondRun).toHaveLength(firstRun.length);
      firstRun.forEach((campaign, i) => {
        expect(
          secondRun[i].startDate.getTime() - campaign.startDate.getTime(),
        ).toBe(10 * DAY);
        expect(
          secondRun[i].endDate.getTime() - campaign.endDate.getTime(),
        ).toBe(10 * DAY);
      });
      expect(
        secondBroadcasts[0].scheduledAt.getTime() -
          firstBroadcasts[0].scheduledAt.getTime(),
      ).toBe(10 * DAY);

      // Les campagnes en cours encadrent bien le moment de la remise à zéro.
      const inProgress = firstRun.filter(
        (c) => c.status === CampaignStatus.IN_PROGRESS,
      );
      expect(inProgress).toHaveLength(2);
      for (const campaign of inProgress) {
        expect(campaign.startDate.getTime()).toBeLessThan(now.getTime());
        expect(campaign.endDate.getTime()).toBeGreaterThan(now.getTime());
      }
      expect(
        firstBroadcasts.some((b) => b.scheduledAt.getTime() < now.getTime()),
      ).toBe(true);
      expect(
        firstBroadcasts.some((b) => b.scheduledAt.getTime() > now.getTime()),
      ).toBe(true);
    });

    it('should seed one campaign of each kind for list variety', async () => {
      await service.reset(now);
      const campaigns = callsOf('campaign', 'create').map(
        (c) => c.args.data as { type: CampaignType; status: CampaignStatus },
      );
      expect(campaigns.map((c) => `${c.type}:${c.status}`).sort()).toEqual(
        [
          'DIGITAL:PLANNED',
          'POSTER:IN_PROGRESS',
          'RADIO:COMPLETED',
          'RADIO:DRAFT',
          'RADIO:IN_PROGRESS',
        ].sort(),
      );
      expect(callsOf('digitalSimulation', 'create')).toHaveLength(1);
      const simulation = callsOf('digitalSimulation', 'create')[0].args
        .data as { predictedReach: number; aiAnalysis: { summary: string } };
      expect(simulation.predictedReach).toBeGreaterThan(0);
      expect(simulation.aiAnalysis.summary.length).toBeGreaterThan(0);
    });
  });

  describe('resetIfStale', () => {
    it('should reset when the demo company does not exist', async () => {
      await expect(service.resetIfStale(now)).resolves.toBe(true);
      expect(callsOf('company', 'create')).toHaveLength(1);
    });

    it('should not reset fresh data, but reset data older than 24 h', async () => {
      await service.reset(now);
      fake.calls.length = 0;

      await expect(
        service.resetIfStale(new Date(now.getTime() + DEMO_MAX_AGE_MS - 1000)),
      ).resolves.toBe(false);
      expect(fake.calls.filter((c) => c.method === 'deleteMany')).toHaveLength(
        0,
      );

      await expect(
        service.resetIfStale(new Date(now.getTime() + DEMO_MAX_AGE_MS + 1000)),
      ).resolves.toBe(true);
    });
  });

  it('should skip the nightly reset when the demo is disabled', async () => {
    config.get.mockImplementation((key: string) =>
      key === 'DEMO_ENABLED' ? 'false' : undefined,
    );
    await service.nightlyReset();
    expect(fake.calls).toHaveLength(0);
  });
});
