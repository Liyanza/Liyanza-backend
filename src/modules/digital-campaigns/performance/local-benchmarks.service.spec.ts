import { DigitalObjective } from '@prisma/client';
import {
  LocalBenchmarksService,
  normalizeCity,
} from './local-benchmarks.service';
import type { PrismaService } from '../../prisma/prisma.service';

/** Observation : 10 000 FCFA, 5 000 impressions (CPM 2 000), 50 clics (CTR 1 %). */
const obs = (companyId: string, city: string | null, overrides = {}) => ({
  companyId,
  city,
  spendXaf: 10000,
  impressions: 5000,
  clicks: 50,
  conversions: 2,
  ...overrides,
});

describe('LocalBenchmarksService', () => {
  let prisma: {
    adPerformanceObservation: { findMany: jest.Mock; upsert: jest.Mock };
    company: { findUnique: jest.Mock };
  };
  let service: LocalBenchmarksService;

  beforeEach(() => {
    prisma = {
      adPerformanceObservation: { findMany: jest.fn(), upsert: jest.fn() },
      company: {
        findUnique: jest.fn().mockResolvedValue({ businessSector: 'Services' }),
      },
    };
    service = new LocalBenchmarksService(prisma as unknown as PrismaService);
  });

  it('should normalize city names', () => {
    expect(normalizeCity(' Yaoundé ')).toBe('yaounde');
    expect(normalizeCity('DOUALA')).toBe('douala');
    expect(normalizeCity('')).toBeNull();
    expect(normalizeCity(undefined)).toBeNull();
  });

  describe('getCalibration', () => {
    it("should prefer the company's own campaigns (2 or more)", async () => {
      prisma.adPerformanceObservation.findMany.mockResolvedValue([
        obs('me', 'douala'),
        obs('me', 'douala', { spendXaf: 20000 }), // CPM 4 000
        obs('a', 'douala'),
        obs('b', 'douala'),
        obs('c', 'douala'),
      ]);

      const result = await service.getCalibration(
        'me',
        DigitalObjective.LEADS,
        ['Douala'],
      );

      expect(result).toEqual({
        scope: 'company',
        city: null,
        campaigns: 2,
        companies: 1,
        cpmFcfa: 3000, // médiane de 2 000 et 4 000
        ctrPercent: 1,
        conversionRatePercent: 4,
      });
    });

    it('should use the same city only with 3 companies or more (anonymity)', async () => {
      prisma.adPerformanceObservation.findMany.mockResolvedValue([
        obs('a', 'douala'),
        obs('b', 'douala'),
        obs('c', 'douala'),
        obs('d', 'yaounde', { spendXaf: 30000 }),
      ]);
      await expect(
        service.getCalibration('me', DigitalObjective.LEADS, ['Douala']),
      ).resolves.toMatchObject({ scope: 'city', city: 'douala', companies: 3 });

      // Yaoundé : 1 seule entreprise → repli sur tout le marché (4 entreprises).
      await expect(
        service.getCalibration('me', DigitalObjective.LEADS, ['Yaoundé']),
      ).resolves.toMatchObject({
        scope: 'objective',
        campaigns: 4,
        companies: 4,
      });
    });

    it('should return nothing below 3 companies', async () => {
      prisma.adPerformanceObservation.findMany.mockResolvedValue([
        obs('a', 'douala'),
        obs('a', 'douala'),
        obs('b', 'douala'),
      ]);
      await expect(
        service.getCalibration('me', DigitalObjective.LEADS, ['Douala']),
      ).resolves.toBeNull();
    });
  });

  describe('record', () => {
    const base = {
      campaignId: 'camp-1',
      companyId: 'me',
      objective: DigitalObjective.LEADS,
      locations: ['Douala'],
      currency: 'XAF',
    };

    it('should store the totals of a campaign that delivered enough', async () => {
      await service.record({
        ...base,
        totals: {
          date_start: '2026-09-01',
          date_stop: '2026-09-20',
          spend: '25000',
          impressions: '12000',
          reach: '8000',
          inline_link_clicks: '140',
          actions: [{ action_type: 'lead', value: '9' }],
        },
      });

      expect(prisma.adPerformanceObservation.upsert).toHaveBeenCalledWith({
        where: { campaignId: 'camp-1' },
        create: expect.objectContaining({
          campaignId: 'camp-1',
          companyId: 'me',
          city: 'douala',
          businessSector: 'Services',
          spendXaf: 25000,
          impressions: 12000,
          clicks: 140,
          conversions: 9,
        }) as Record<string, unknown>,
        update: expect.objectContaining({ spendXaf: 25000 }) as Record<
          string,
          unknown
        >,
      });
    });

    it('should ignore a campaign with too little delivery or a non-convertible currency', async () => {
      const small = {
        date_start: '2026-09-01',
        date_stop: '2026-09-02',
        spend: '2000',
        impressions: '400',
      };
      await service.record({ ...base, totals: small });
      await service.record({
        ...base,
        currency: 'USD',
        totals: { ...small, spend: '100', impressions: '50000' },
      });
      await service.record({ ...base, totals: null });
      expect(prisma.adPerformanceObservation.upsert).not.toHaveBeenCalled();
    });
  });
});
