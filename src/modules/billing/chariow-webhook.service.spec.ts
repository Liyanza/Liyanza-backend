import { createHmac } from 'crypto';
import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BillingPeriod,
  PlanTier,
  Prisma,
  SubscriptionStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ChariowConfig } from './chariow.config';
import { addMonthsUtc, ChariowWebhookService } from './chariow-webhook.service';

const SECRET = 'whsec_test_secret_123456';
const ENV: Record<string, string> = {
  CHARIOW_API_KEY: 'sk_live_x',
  CHARIOW_PULSE_SECRET: SECRET,
  CHARIOW_PRODUCT_PRO_MONTHLY: 'prd_pro_m',
  CHARIOW_PRODUCT_PRO_YEARLY: 'prd_pro_y',
  CHARIOW_PRODUCT_BUSINESS_MONTHLY: 'prd_biz_m',
  CHARIOW_PRODUCT_BUSINESS_YEARLY: 'prd_biz_y',
};

const uniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });

describe('ChariowWebhookService', () => {
  let service: ChariowWebhookService;
  let prisma: {
    chariowDelivery: { create: jest.Mock; delete: jest.Mock };
    company: { findUnique: jest.Mock };
    user: { findFirst: jest.Mock };
    subscription: {
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
    };
    $transaction: jest.Mock;
  };
  let tx: { subscription: { aggregate: jest.Mock; create: jest.Mock } };

  const sign = (body: Buffer) =>
    `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;

  /** Envoie une Pulse correctement signée. */
  const deliver = (payload: object, deliveryId: string | null = 'dlv_1') => {
    const raw = Buffer.from(JSON.stringify(payload));
    return service.handle(raw, sign(raw), deliveryId ?? undefined);
  };

  const sale = (overrides: Record<string, unknown> = {}) => ({
    event: 'successful.sale',
    sale: {
      id: 'sal_1',
      amount: { value: 20000, formatted: '20 000 FCFA', currency: 'XAF' },
      status: 'completed',
      custom_metadata: {
        company_id: 'company-1',
        user_id: 'user-1',
        plan: 'PRO',
        period: 'MONTHLY',
      },
    },
    product: { id: 'prd_pro_m', name: 'Kiyanza PRO' },
    customer: { id: 'cus_1', email: 'Admin@Acme.com' },
    ...overrides,
  });

  beforeEach(() => {
    tx = {
      subscription: {
        aggregate: jest.fn().mockResolvedValue({ _max: { expiresAt: null } }),
        create: jest.fn().mockResolvedValue({ id: 'sub-1' }),
      },
    };
    prisma = {
      chariowDelivery: {
        create: jest.fn().mockResolvedValue({}),
        delete: jest.fn().mockResolvedValue({}),
      },
      company: { findUnique: jest.fn().mockResolvedValue({ id: 'company-1' }) },
      user: { findFirst: jest.fn().mockResolvedValue({ id: 'user-1' }) },
      subscription: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest.fn((cb: (client: typeof tx) => unknown) => cb(tx)),
    };
    const config = new ChariowConfig({
      get: (key: string) => ENV[key],
    } as unknown as ConfigService);
    service = new ChariowWebhookService(
      prisma as unknown as PrismaService,
      config,
    );
  });

  describe('authentication', () => {
    it('should 401 on an invalid signature, without touching the database', async () => {
      const raw = Buffer.from(JSON.stringify(sale()));
      await expect(
        service.handle(raw, 'sha256=deadbeef', 'dlv_1'),
      ).rejects.toThrow(UnauthorizedException);
      expect(prisma.chariowDelivery.create).not.toHaveBeenCalled();
    });

    it('should 401 when no Pulse secret is configured', async () => {
      const config = new ChariowConfig({
        get: (key: string) =>
          key === 'CHARIOW_PULSE_SECRET' ? undefined : ENV[key],
      } as unknown as ConfigService);
      service = new ChariowWebhookService(
        prisma as unknown as PrismaService,
        config,
      );
      await expect(deliver(sale())).rejects.toThrow(UnauthorizedException);
    });
  });

  it('should acknowledge a dashboard test pulse (no delivery id) with no effect', async () => {
    await expect(deliver(sale(), null)).resolves.toEqual({
      ok: true,
      test: true,
    });
    expect(prisma.chariowDelivery.create).not.toHaveBeenCalled();
    expect(tx.subscription.create).not.toHaveBeenCalled();
  });

  it('should not reprocess a delivery already received', async () => {
    prisma.chariowDelivery.create.mockRejectedValue(uniqueViolation());

    await expect(deliver(sale())).resolves.toEqual({
      ok: true,
      duplicate: true,
    });
    expect(tx.subscription.create).not.toHaveBeenCalled();
  });

  describe('successful.sale', () => {
    it('should grant the purchased plan to the company', async () => {
      const before = Date.now();
      await expect(deliver(sale())).resolves.toEqual({ ok: true });

      expect(prisma.chariowDelivery.create).toHaveBeenCalledWith({
        data: { id: 'dlv_1', event: 'successful.sale' },
      });
      const [[{ data }]] = tx.subscription.create.mock.calls as [
        [
          {
            data: Record<string, unknown> & { startsAt: Date; expiresAt: Date };
          },
        ],
      ];
      expect(data).toMatchObject({
        companyId: 'company-1',
        plan: PlanTier.PRO,
        period: BillingPeriod.MONTHLY,
        status: SubscriptionStatus.ACTIVE,
        chariowSaleId: 'sal_1',
        chariowProductId: 'prd_pro_m',
        customerEmail: 'admin@acme.com',
        purchasedById: 'user-1',
        amount: '20 000 FCFA',
      });
      expect(data.startsAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(data.expiresAt).toEqual(addMonthsUtc(data.startsAt, 1));
    });

    it('should stack a renewal after the current period of the same plan', async () => {
      const currentEnd = new Date(Date.now() + 10 * 24 * 3600 * 1000);
      tx.subscription.aggregate.mockResolvedValue({
        _max: { expiresAt: currentEnd },
      });

      await deliver(
        sale({
          product: { id: 'prd_pro_y' },
          sale: {
            id: 'sal_2',
            custom_metadata: {
              company_id: 'company-1',
              plan: 'PRO',
              period: 'YEARLY',
            },
          },
        }),
      );

      expect(tx.subscription.aggregate).toHaveBeenCalledWith({
        where: {
          companyId: 'company-1',
          plan: PlanTier.PRO,
          status: SubscriptionStatus.ACTIVE,
        },
        _max: { expiresAt: true },
      });
      const [[{ data }]] = tx.subscription.create.mock.calls as [
        [{ data: { startsAt: Date; expiresAt: Date; period: BillingPeriod } }],
      ];
      expect(data.period).toBe(BillingPeriod.YEARLY);
      expect(data.startsAt).toEqual(currentEnd);
      expect(data.expiresAt).toEqual(addMonthsUtc(currentEnd, 12));
    });

    it('should trust the product when the metadata has no plan/period', async () => {
      await deliver(
        sale({
          product: { id: 'prd_biz_m' },
          sale: { id: 'sal_3', custom_metadata: { company_id: 'company-1' } },
        }),
      );
      expect(tx.subscription.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          plan: PlanTier.BUSINESS,
          purchasedById: null,
        }) as object,
      });
    });

    it('should grant nothing for an unknown product (still 200)', async () => {
      await expect(
        deliver(sale({ product: { id: 'prd_unknown' } })),
      ).resolves.toEqual({ ok: true });
      expect(tx.subscription.create).not.toHaveBeenCalled();
    });

    it('should grant nothing when the metadata contradicts the product', async () => {
      // Produit PRO mensuel payé, métadonnées réclamant BUSINESS.
      const payload = sale();
      payload.sale.custom_metadata.plan = 'BUSINESS';
      await deliver(payload);
      expect(tx.subscription.create).not.toHaveBeenCalled();
    });

    it('should grant nothing when the company is missing or unknown', async () => {
      prisma.company.findUnique.mockResolvedValue(null);
      await deliver(sale());
      const payload = sale();
      payload.sale.custom_metadata = {} as typeof payload.sale.custom_metadata;
      await deliver(payload, 'dlv_2');
      expect(tx.subscription.create).not.toHaveBeenCalled();
    });

    it('should not grant the same sale twice', async () => {
      prisma.subscription.findUnique.mockResolvedValue({ id: 'sub-1' });
      await deliver(sale(), 'dlv_other');
      expect(tx.subscription.create).not.toHaveBeenCalled();
    });

    it('should forget the delivery when processing fails, so the retry is processed', async () => {
      tx.subscription.create.mockRejectedValue(new Error('db down'));
      await expect(deliver(sale())).rejects.toThrow('db down');
      expect(prisma.chariowDelivery.delete).toHaveBeenCalledWith({
        where: { id: 'dlv_1' },
      });
    });
  });

  describe('licenses', () => {
    const license = (event: string, key = 'ABCD-1234') => ({
      event,
      license: { id: 'lic_1', key, status: 'active' },
      product: { id: 'prd_pro_m' },
      customer: { email: 'ADMIN@acme.com' },
    });

    it('should attach an issued license to the latest matching subscription', async () => {
      prisma.subscription.findFirst.mockResolvedValue({ id: 'sub-1' });

      await deliver(license('license.issued'));

      expect(prisma.subscription.findFirst).toHaveBeenCalledWith({
        where: {
          status: SubscriptionStatus.ACTIVE,
          chariowProductId: 'prd_pro_m',
          customerEmail: 'admin@acme.com',
          licenseKey: null,
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      expect(prisma.subscription.update).toHaveBeenCalledWith({
        where: { id: 'sub-1' },
        data: { licenseKey: 'ABCD-1234' },
      });
    });

    it('should revoke the subscription holding the license', async () => {
      prisma.subscription.findUnique.mockResolvedValue({ id: 'sub-1' });

      await deliver(license('license.revoked'));

      expect(prisma.subscription.update).toHaveBeenCalledWith({
        where: { id: 'sub-1' },
        data: { status: SubscriptionStatus.REVOKED },
      });
    });

    it('should fall back to the latest purchase of the product by the customer', async () => {
      prisma.subscription.findFirst.mockResolvedValue({ id: 'sub-9' });

      await deliver(license('license.revoked', 'UNKNOWN-KEY'));

      expect(prisma.subscription.update).toHaveBeenCalledWith({
        where: { id: 'sub-9' },
        data: { status: SubscriptionStatus.REVOKED },
      });
    });

    it('should ignore expiry events (our own dates drive expiry)', async () => {
      await expect(deliver(license('license.expired'))).resolves.toEqual({
        ok: true,
      });
      expect(prisma.subscription.update).not.toHaveBeenCalled();
    });
  });

  describe('addMonthsUtc', () => {
    it('should clamp to the last day of a shorter month', () => {
      expect(addMonthsUtc(new Date('2027-01-31T10:00:00Z'), 1)).toEqual(
        new Date('2027-02-28T10:00:00Z'),
      );
      expect(addMonthsUtc(new Date('2028-02-29T00:00:00Z'), 12)).toEqual(
        new Date('2029-02-28T00:00:00Z'),
      );
      expect(addMonthsUtc(new Date('2026-12-15T00:00:00Z'), 1)).toEqual(
        new Date('2027-01-15T00:00:00Z'),
      );
    });
  });
});
