import {
  BadGatewayException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BillingPeriod, PlanTier, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { BillingService } from './billing.service';
import { ChariowClient } from './chariow.client';
import { ChariowConfig } from './chariow.config';
import { PLAN_LIMITS } from './plan-limits';
import { PlanService } from './plan.service';

const ENV: Record<string, string> = {
  CHARIOW_API_KEY: 'sk_live_secret_key',
  CHARIOW_PRODUCT_PRO_MONTHLY: 'prd_pro_m',
  CHARIOW_PRODUCT_PRO_YEARLY: 'prd_pro_y',
  CHARIOW_PRODUCT_BUSINESS_MONTHLY: 'prd_biz_m',
  CHARIOW_PRODUCT_BUSINESS_YEARLY: 'prd_biz_y',
  BILLING_RETURN_URL: 'https://www.kiyanza.com/dashboard/abonnement',
};

const configFrom = (env: Record<string, string | undefined>) =>
  new ChariowConfig({
    get: (key: string) => env[key],
  } as unknown as ConfigService);

describe('BillingService', () => {
  let prisma: {
    user: { findUnique: jest.Mock };
    subscription: { findMany: jest.Mock };
  };
  let plans: { getEffectivePlan: jest.Mock; getUsage: jest.Mock };
  const admin: AuthenticatedUser = {
    userId: 'user-1',
    email: 'admin@acme.com',
    role: Role.ADMIN,
    companyId: 'company-1',
  };
  const dto = {
    plan: PlanTier.PRO,
    period: BillingPeriod.YEARLY,
    phone: { number: '690000000' },
  };

  beforeEach(() => {
    prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          email: 'admin@acme.com',
          firstName: 'A'.repeat(60),
          lastName: '  ',
        }),
      },
      subscription: { findMany: jest.fn().mockResolvedValue([]) },
    };
    plans = { getEffectivePlan: jest.fn(), getUsage: jest.fn() };
  });

  const build = (config = configFrom(ENV)) => {
    const client = new ChariowClient(config);
    const service = new BillingService(
      prisma as unknown as PrismaService,
      plans as unknown as PlanService,
      client,
      config,
    );
    return { service, client };
  };

  describe('createCheckout', () => {
    let fetchMock: jest.SpyInstance;

    beforeEach(() => {
      fetchMock = jest.spyOn(global, 'fetch');
    });
    afterEach(() => fetchMock.mockRestore());

    const respond = (status: number, body: unknown) =>
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    it('should call Chariow with the product of the plan and the company metadata', async () => {
      respond(200, {
        data: {
          step: 'payment',
          payment: { checkout_url: 'https://pay.chariow.com/c/abc' },
        },
      });
      const { service } = build();

      await expect(
        service.createCheckout(dto, admin, '41.202.1.2'),
      ).resolves.toEqual({ checkoutUrl: 'https://pay.chariow.com/c/abc' });

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.chariow.com/v1/checkout');
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>).Authorization).toBe(
        'Bearer sk_live_secret_key',
      );
      expect(JSON.parse(init.body as string)).toEqual({
        product_id: 'prd_pro_y',
        email: 'admin@acme.com',
        first_name: 'A'.repeat(50),
        last_name: 'A'.repeat(50),
        phone: { number: '690000000', country_code: 'CM' },
        redirect_url: 'https://www.kiyanza.com/dashboard/abonnement',
        customer_ip: '41.202.1.2',
        custom_metadata: {
          company_id: 'company-1',
          user_id: 'user-1',
          plan: 'PRO',
          period: 'YEARLY',
        },
      });
    });

    it('should return no URL when Chariow says the product is already purchased', async () => {
      respond(200, { data: { step: 'already_purchased', payment: null } });
      const { service } = build();
      await expect(
        service.createCheckout(dto, admin, undefined),
      ).resolves.toEqual({ checkoutUrl: null, step: 'already_purchased' });
    });

    it('should map a Chariow error to a 502 without leaking the API key', async () => {
      respond(422, { message: 'The phone number is invalid' });
      const { service } = build();
      const error = await service
        .createCheckout(dto, admin, undefined)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadGatewayException);
      expect(
        JSON.stringify((error as BadGatewayException).getResponse()),
      ).not.toContain('sk_live');
    });

    it('should map a network failure or timeout to a 502', async () => {
      fetchMock.mockRejectedValue(new Error('The operation was aborted'));
      const { service } = build();
      await expect(
        service.createCheckout(dto, admin, undefined),
      ).rejects.toThrow(BadGatewayException);
    });

    it('should answer 503 when billing is not configured', async () => {
      const { service } = build(
        configFrom({ ...ENV, CHARIOW_API_KEY: undefined }),
      );
      await expect(
        service.createCheckout(dto, admin, undefined),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('should refuse a user without company', async () => {
      const { service } = build();
      await expect(
        service.createCheckout(dto, { ...admin, companyId: null }, undefined),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('getSubscription', () => {
    it('should combine plan, limits, usage and history', async () => {
      const expiresAt = new Date('2027-10-12T00:00:00Z');
      plans.getEffectivePlan.mockResolvedValue({
        plan: 'PRO',
        source: 'PAID',
        expiresAt,
        trialEndsAt: null,
        limits: PLAN_LIMITS.PRO,
      });
      plans.getUsage.mockResolvedValue({
        activeCampaigns: 2,
        members: 2,
        copilotMessagesToday: 7,
      });
      const createdAt = new Date('2026-10-12T00:00:00Z');
      prisma.subscription.findMany.mockResolvedValue([
        {
          id: 'sub-1',
          plan: 'PRO',
          period: 'YEARLY',
          status: 'ACTIVE',
          startsAt: createdAt,
          expiresAt,
          amount: '240 000 FCFA',
          createdAt,
        },
      ]);
      const { service } = build();

      await expect(service.getSubscription(admin)).resolves.toEqual({
        plan: 'PRO',
        source: 'PAID',
        expiresAt: expiresAt.toISOString(),
        trialEndsAt: null,
        limits: PLAN_LIMITS.PRO,
        usage: { activeCampaigns: 2, members: 2, copilotMessagesToday: 7 },
        billingEnabled: true,
        history: [
          {
            id: 'sub-1',
            plan: 'PRO',
            period: 'YEARLY',
            status: 'ACTIVE',
            startsAt: createdAt.toISOString(),
            expiresAt: expiresAt.toISOString(),
            amount: '240 000 FCFA',
            createdAt: createdAt.toISOString(),
          },
        ],
      });
      expect(prisma.subscription.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { companyId: 'company-1' },
          take: 20,
        }),
      );
    });

    it('should answer FREE for a user without company', async () => {
      const { service } = build(configFrom({}));
      await expect(
        service.getSubscription({ ...admin, companyId: null }),
      ).resolves.toMatchObject({
        plan: 'FREE',
        source: 'FREE',
        billingEnabled: false,
        history: [],
      });
      expect(plans.getEffectivePlan).not.toHaveBeenCalled();
    });
  });
});
