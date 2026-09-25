import { CampaignAlertsService } from './campaign-alerts.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { NotificationsService } from '../../notifications/notifications.service';
import type { DetectedAlert } from './alert-rules';

describe('CampaignAlertsService', () => {
  const campaign = {
    id: 'camp-1',
    name: 'Promo octobre',
    launchedById: 'creator',
  };
  const cpcHigh: DetectedAlert = {
    type: 'CPC_HIGH',
    severity: 'WARNING',
    data: { actualCpc: 1800, predictedCpc: 950 },
  };

  let prisma: {
    campaignAlert: {
      findMany: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    user: { findMany: jest.Mock };
  };
  let notifications: { creer: jest.Mock };
  let service: CampaignAlertsService;

  beforeEach(() => {
    prisma = {
      campaignAlert: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      user: {
        // Le créateur est aussi administrateur : une seule notification pour lui.
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'creator' }, { id: 'manager' }]),
      },
    };
    notifications = { creer: jest.fn().mockResolvedValue(undefined) };
    service = new CampaignAlertsService(
      prisma as unknown as PrismaService,
      notifications as unknown as NotificationsService,
    );
  });

  it('should open a new alert and notify the creator and managers once each', async () => {
    await service.evaluate(campaign, 'company-1', [cpcHigh]);

    expect(prisma.campaignAlert.create).toHaveBeenCalledWith({
      data: {
        campaignId: 'camp-1',
        type: 'CPC_HIGH',
        severity: 'WARNING',
        data: { actualCpc: 1800, predictedCpc: 950 },
      },
    });
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: {
        companyId: 'company-1',
        role: { in: ['ADMIN', 'MARKETING_MANAGER'] },
      },
      select: { id: true },
    });
    expect(notifications.creer).toHaveBeenCalledTimes(2);
    expect(notifications.creer).toHaveBeenCalledWith({
      title: 'Coût par clic élevé · Promo octobre',
      message: expect.stringMatching(/1\s800\sFCFA/) as string,
      type: 'WARNING',
      recipientId: 'manager',
    });
  });

  it('should update an alert still open without notifying again', async () => {
    prisma.campaignAlert.findMany.mockResolvedValue([
      { id: 'a1', type: 'CPC_HIGH' },
    ]);

    await service.evaluate(campaign, 'company-1', [
      { ...cpcHigh, severity: 'CRITICAL' },
    ]);

    expect(prisma.campaignAlert.update).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: { severity: 'CRITICAL', data: cpcHigh.data },
    });
    expect(prisma.campaignAlert.create).not.toHaveBeenCalled();
    expect(notifications.creer).not.toHaveBeenCalled();
  });

  it('should resolve alerts whose problem is gone', async () => {
    prisma.campaignAlert.findMany.mockResolvedValue([
      { id: 'a1', type: 'CPC_HIGH' },
      { id: 'a2', type: 'CTR_LOW' },
    ]);

    await service.evaluate(campaign, 'company-1', [cpcHigh]);

    expect(prisma.campaignAlert.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['a2'] } },
      data: { resolvedAt: expect.any(Date) as Date },
    });
  });

  it('should send critical alerts as errors and survive a notification failure', async () => {
    notifications.creer.mockRejectedValueOnce(new Error('down'));

    await expect(
      service.evaluate(campaign, 'company-1', [
        { type: 'NO_CONVERSIONS', severity: 'CRITICAL', data: { expected: 4 } },
      ]),
    ).resolves.toBeUndefined();
    expect(notifications.creer).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'ERROR',
        title: 'Aucune conversion · Promo octobre',
      }),
    );
  });
});
