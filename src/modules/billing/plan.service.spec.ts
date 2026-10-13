import { CampaignStatus, PlanTier, SubscriptionStatus } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { PlanLimitException, requiredPlanFor } from './plan-limits';
import { PlanService } from './plan.service';

const DAY = 24 * 60 * 60 * 1000;

describe('PlanService', () => {
  let service: PlanService;
  let config: { get: jest.Mock };
  let prisma: {
    company: { findUnique: jest.Mock };
    subscription: { findMany: jest.Mock };
    campaign: { count: jest.Mock };
    user: { count: jest.Mock };
    aiMessage: { count: jest.Mock };
  };
  // Horloge réelle : les assertions appellent `getEffectivePlan` sans `now`.
  const now = new Date();
  const at = (days: number) => new Date(now.getTime() + days * DAY);

  /** Abonnements ACTIVE renvoyés par la requête (déjà filtrés `expiresAt > now`). */
  const givenSubscriptions = (
    subs: { plan: PlanTier; startsAt: Date; expiresAt: Date }[],
  ) => prisma.subscription.findMany.mockResolvedValue(subs);

  beforeEach(() => {
    prisma = {
      company: {
        findUnique: jest.fn().mockResolvedValue({ trialEndsAt: null }),
      },
      subscription: { findMany: jest.fn().mockResolvedValue([]) },
      campaign: { count: jest.fn().mockResolvedValue(0) },
      user: { count: jest.fn().mockResolvedValue(0) },
      aiMessage: { count: jest.fn().mockResolvedValue(0) },
    };
    config = { get: jest.fn().mockReturnValue(undefined) };
    service = new PlanService(
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
    );
  });

  describe('getEffectivePlan', () => {
    it('should be FREE without subscription nor trial', async () => {
      await expect(service.getEffectivePlan('c1', now)).resolves.toMatchObject({
        plan: 'FREE',
        source: 'FREE',
        expiresAt: null,
      });
    });

    it('should be PRO (TRIAL) while the trial runs, FREE once it ended', async () => {
      prisma.company.findUnique.mockResolvedValue({ trialEndsAt: at(3) });
      await expect(service.getEffectivePlan('c1', now)).resolves.toMatchObject({
        plan: 'PRO',
        source: 'TRIAL',
        trialEndsAt: at(3),
      });

      prisma.company.findUnique.mockResolvedValue({ trialEndsAt: at(-1) });
      await expect(service.getEffectivePlan('c1', now)).resolves.toMatchObject({
        plan: 'FREE',
        source: 'FREE',
        trialEndsAt: at(-1),
      });
    });

    it('should prefer a paid plan over the trial', async () => {
      prisma.company.findUnique.mockResolvedValue({ trialEndsAt: at(3) });
      givenSubscriptions([
        { plan: PlanTier.BUSINESS, startsAt: at(-5), expiresAt: at(25) },
      ]);
      await expect(service.getEffectivePlan('c1', now)).resolves.toMatchObject({
        plan: 'BUSINESS',
        source: 'PAID',
        expiresAt: at(25),
      });
    });

    it('should only read ACTIVE, unexpired subscriptions of the company', async () => {
      await service.getEffectivePlan('c1', now);
      expect(prisma.subscription.findMany).toHaveBeenCalledWith({
        where: {
          companyId: 'c1',
          status: SubscriptionStatus.ACTIVE,
          expiresAt: { gt: now },
        },
        select: { plan: true, startsAt: true, expiresAt: true },
      });
    });

    it('should keep the highest current tier', async () => {
      givenSubscriptions([
        { plan: PlanTier.PRO, startsAt: at(-5), expiresAt: at(300) },
        { plan: PlanTier.BUSINESS, startsAt: at(-1), expiresAt: at(29) },
      ]);
      await expect(service.getEffectivePlan('c1', now)).resolves.toMatchObject({
        plan: 'BUSINESS',
        expiresAt: at(29),
      });
    });

    it('should ignore a subscription that has not started yet', async () => {
      givenSubscriptions([
        { plan: PlanTier.BUSINESS, startsAt: at(5), expiresAt: at(35) },
      ]);
      await expect(service.getEffectivePlan('c1', now)).resolves.toMatchObject({
        plan: 'FREE',
      });
    });

    it('should report the end of stacked renewals of the current tier', async () => {
      givenSubscriptions([
        { plan: PlanTier.PRO, startsAt: at(-20), expiresAt: at(10) },
        { plan: PlanTier.PRO, startsAt: at(10), expiresAt: at(40) },
      ]);
      await expect(service.getEffectivePlan('c1', now)).resolves.toMatchObject({
        plan: 'PRO',
        source: 'PAID',
        expiresAt: at(40),
      });
    });
  });

  describe('limits', () => {
    it('should block a second active campaign on FREE (drafts count, closed ones do not)', async () => {
      prisma.campaign.count.mockResolvedValue(1);

      const error = await service
        .assertCanCreateCampaign('c1')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(PlanLimitException);
      expect((error as PlanLimitException).getResponse()).toEqual({
        statusCode: 403,
        code: 'PLAN_LIMIT',
        feature: 'campaigns',
        requiredPlan: 'PRO',
        limit: 1,
        message: expect.any(String) as string,
      });
      expect(prisma.campaign.count).toHaveBeenCalledWith({
        where: {
          launchedBy: { companyId: 'c1' },
          status: {
            notIn: [CampaignStatus.COMPLETED, CampaignStatus.CANCELLED],
          },
        },
      });
    });

    it('should not even count campaigns on PRO (unlimited)', async () => {
      prisma.company.findUnique.mockResolvedValue({ trialEndsAt: at(3) });
      await expect(service.assertCanCreateCampaign('c1')).resolves.toBe(
        undefined,
      );
      expect(prisma.campaign.count).not.toHaveBeenCalled();
    });

    it('should cap members at 3 on PRO and ask for BUSINESS', async () => {
      prisma.company.findUnique.mockResolvedValue({ trialEndsAt: at(3) });
      prisma.user.count.mockResolvedValue(3);

      await expect(service.assertCanAddMember('c1')).rejects.toMatchObject({
        feature: 'members',
        requiredPlan: 'BUSINESS',
        limit: 3,
      });
      expect(prisma.user.count).toHaveBeenCalledWith({
        where: { companyId: 'c1', deactivatedAt: null },
      });

      prisma.user.count.mockResolvedValue(2);
      await expect(service.assertCanAddMember('c1')).resolves.toBe(undefined);
    });

    it('should cap FREE at a single member and ask for PRO', async () => {
      prisma.user.count.mockResolvedValue(1);
      await expect(service.assertCanAddMember('c1')).rejects.toMatchObject({
        feature: 'members',
        requiredPlan: 'PRO',
        limit: 1,
      });
    });

    it('should enforce the daily Copilot quota on FREE (user messages, UTC day)', async () => {
      prisma.aiMessage.count.mockResolvedValue(5);

      await expect(service.assertCopilotQuota('c1')).rejects.toMatchObject({
        feature: 'copilot',
        requiredPlan: 'PRO',
        limit: 5,
      });
      const [[query]] = prisma.aiMessage.count.mock.calls as [
        [{ where: { sender: string; sentAt: { gte: Date } } }],
      ];
      expect(query.where).toMatchObject({
        sender: 'USER',
        conversation: { companyId: 'c1' },
      });
      const gte = query.where.sentAt.gte;
      expect(
        gte.getUTCHours() + gte.getUTCMinutes() + gte.getUTCSeconds(),
      ).toBe(0);

      prisma.aiMessage.count.mockResolvedValue(4);
      await expect(service.assertCopilotQuota('c1')).resolves.toBe(undefined);
    });

    it('should cap the Copilot of the demo company (DEMO_COPILOT_DAILY_MESSAGES, default 30) while keeping PRO', async () => {
      prisma.company.findUnique.mockResolvedValue({
        trialEndsAt: at(365),
        isDemo: true,
      });
      await expect(
        service.getEffectivePlan('demo', now),
      ).resolves.toMatchObject({
        plan: 'PRO',
        limits: { copilotDailyMessages: 30, aiAdvanced: true },
      });

      prisma.aiMessage.count.mockResolvedValue(30);
      await expect(service.assertCopilotQuota('demo')).rejects.toMatchObject({
        feature: 'copilot',
        limit: 30,
      });
      prisma.aiMessage.count.mockResolvedValue(29);
      await expect(service.assertCopilotQuota('demo')).resolves.toBe(undefined);

      config.get.mockReturnValue(3);
      prisma.aiMessage.count.mockResolvedValue(3);
      await expect(service.assertCopilotQuota('demo')).rejects.toMatchObject({
        limit: 3,
      });
    });

    it('should not cap the Copilot of a real PRO company', async () => {
      prisma.company.findUnique.mockResolvedValue({
        trialEndsAt: at(3),
        isDemo: false,
      });
      prisma.aiMessage.count.mockResolvedValue(1000);
      await expect(service.assertCopilotQuota('c1')).resolves.toBe(undefined);
    });

    it('should reserve advanced AI to paid plans and the trial', async () => {
      await expect(service.hasAiAdvanced('c1')).resolves.toBe(false);
      await expect(service.assertAiAdvanced('c1')).rejects.toMatchObject({
        feature: 'aiAdvanced',
        requiredPlan: 'PRO',
        limit: null,
      });

      givenSubscriptions([
        { plan: PlanTier.PRO, startsAt: at(-1), expiresAt: at(29) },
      ]);
      await expect(service.hasAiAdvanced('c1')).resolves.toBe(true);
      await expect(service.assertAiAdvanced('c1')).resolves.toBe(undefined);
    });
  });

  it('should report usage', async () => {
    prisma.campaign.count.mockResolvedValue(2);
    prisma.user.count.mockResolvedValue(3);
    prisma.aiMessage.count.mockResolvedValue(4);
    await expect(service.getUsage('c1', now)).resolves.toEqual({
      activeCampaigns: 2,
      members: 3,
      copilotMessagesToday: 4,
    });
  });

  it('requiredPlanFor should name the first plan lifting the limit', () => {
    expect(requiredPlanFor('campaigns', 'FREE')).toBe('PRO');
    expect(requiredPlanFor('members', 'FREE')).toBe('PRO');
    expect(requiredPlanFor('members', 'PRO')).toBe('BUSINESS');
    expect(requiredPlanFor('aiAdvanced', 'FREE')).toBe('PRO');
  });
});
