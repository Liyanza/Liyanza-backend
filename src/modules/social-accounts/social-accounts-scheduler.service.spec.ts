import { Test, TestingModule } from '@nestjs/testing';
import { SocialAccountsSchedulerService } from './social-accounts-scheduler.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SocialPlatform } from '@prisma/client';

describe('SocialAccountsSchedulerService', () => {
  let service: SocialAccountsSchedulerService;
  let prisma: {
    socialAccount: { findMany: jest.Mock; updateMany: jest.Mock };
  };
  let notificationsService: { creer: jest.Mock };

  beforeEach(async () => {
    notificationsService = { creer: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SocialAccountsSchedulerService,
        {
          provide: PrismaService,
          useValue: {
            socialAccount: { findMany: jest.fn(), updateMany: jest.fn() },
          },
        },
        { provide: NotificationsService, useValue: notificationsService },
      ],
    }).compile();

    service = module.get(SocialAccountsSchedulerService);
    prisma = module.get(PrismaService);
  });

  it('should do nothing when no account is expiring soon', async () => {
    prisma.socialAccount.findMany.mockResolvedValue([]);

    await service.checkExpiringSocialAccounts();

    expect(prisma.socialAccount.updateMany).not.toHaveBeenCalled();
    expect(notificationsService.creer).not.toHaveBeenCalled();
  });

  it('should notify each connecting user once and mark expiryReminderSentAt (idempotence)', async () => {
    prisma.socialAccount.findMany.mockResolvedValue([
      {
        id: 'sa-1',
        platform: SocialPlatform.FACEBOOK,
        externalAccountName: 'My Page',
        externalAccountId: 'page-1',
        connectedById: 'user-1',
      },
      {
        id: 'sa-2',
        platform: SocialPlatform.INSTAGRAM,
        externalAccountName: null,
        externalAccountId: 'ig-1',
        connectedById: 'user-2',
      },
    ]);

    await service.checkExpiringSocialAccounts();

    const updateManyMock = prisma.socialAccount.updateMany as jest.Mock<
      unknown,
      [
        {
          where: { id: { in: string[] } };
          data: { expiryReminderSentAt: Date };
        },
      ]
    >;
    const [updateManyArgs] = updateManyMock.mock.calls[0];
    expect(updateManyArgs.where).toEqual({ id: { in: ['sa-1', 'sa-2'] } });
    expect(updateManyArgs.data.expiryReminderSentAt).toBeInstanceOf(Date);
    expect(notificationsService.creer).toHaveBeenCalledTimes(2);
    expect(notificationsService.creer).toHaveBeenCalledWith(
      expect.objectContaining({ recipientId: 'user-1' }),
    );
    expect(notificationsService.creer).toHaveBeenCalledWith(
      expect.objectContaining({ recipientId: 'user-2' }),
    );
  });

  it('should only query accounts with no reminder already sent (idempotence guard in the read)', async () => {
    prisma.socialAccount.findMany.mockResolvedValue([]);

    await service.checkExpiringSocialAccounts();

    const findManyMock = prisma.socialAccount.findMany as jest.Mock<
      unknown,
      [{ where: { expiryReminderSentAt: null } }]
    >;
    const [findManyArgs] = findManyMock.mock.calls[0];
    expect(findManyArgs.where.expiryReminderSentAt).toBeNull();
  });
});
