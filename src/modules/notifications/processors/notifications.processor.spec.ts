/* eslint-disable @typescript-eslint/unbound-method */
import { Prisma } from '@prisma/client';
import { Job } from 'bullmq';
import { NotificationsProcessor } from './notifications.processor';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailProvider } from '../../mail/interfaces/email-provider.interface';
import { NotificationType } from '../dto/create-notification.dto';

describe('NotificationsProcessor', () => {
  let processor: NotificationsProcessor;
  let prisma: { notification: { upsert: jest.Mock } };
  let emailProvider: jest.Mocked<EmailProvider>;

  beforeEach(() => {
    prisma = { notification: { upsert: jest.fn() } };
    emailProvider = { send: jest.fn() };
    processor = new NotificationsProcessor(
      prisma as unknown as PrismaService,
      emailProvider,
    );
  });

  describe('"create" job', () => {
    const dto = {
      title: 'Titre',
      message: 'Message',
      type: NotificationType.INFO,
      recipientId: 'user-1',
    };

    const makeJob = (overrides: Partial<Job> = {}): Job =>
      ({ id: 'job-1', name: 'create', data: dto, ...overrides }) as Job;

    it('should persist the notification (keyed by job.id) then email the recipient', async () => {
      prisma.notification.upsert.mockResolvedValue({
        id: 'job-1',
        ...dto,
        recipient: { email: 'user1@test.com' },
      });

      await processor.process(makeJob());

      expect(prisma.notification.upsert).toHaveBeenCalledWith({
        where: { id: 'job-1' },
        update: {},
        create: {
          id: 'job-1',
          title: dto.title,
          message: dto.message,
          type: dto.type,
          sentAt: expect.any(Date) as Date,
          readStatus: 'UNREAD',
          recipientId: dto.recipientId,
        },
        include: { recipient: { select: { email: true } } },
      });
      expect(emailProvider.send).toHaveBeenCalledWith({
        to: 'user1@test.com',
        subject: dto.title,
        text: dto.message,
      });
    });

    it('should default type to INFO if not provided', async () => {
      prisma.notification.upsert.mockResolvedValue({
        id: 'job-2',
        recipient: { email: 'user1@test.com' },
      });

      await processor.process(
        makeJob({
          id: 'job-2',
          data: { ...dto, type: undefined },
        }),
      );

      expect(prisma.notification.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            type: NotificationType.INFO,
          }) as unknown,
        }),
      );
    });

    // RÉGRESSION (idempotence retry) : `job.id` reste stable à travers les
    // tentatives BullMQ — une notification déjà écrite lors d'une tentative
    // précédente ne doit jamais être dupliquée si seul l'envoi d'email avait
    // échoué ensuite.
    it('should reuse the same job.id as the notification id across repeated attempts', async () => {
      prisma.notification.upsert.mockResolvedValue({
        id: 'job-1',
        recipient: { email: 'user1@test.com' },
      });

      await processor.process(makeJob());
      await processor.process(makeJob());

      expect(prisma.notification.upsert).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ where: { id: 'job-1' } }),
      );
      expect(prisma.notification.upsert).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ where: { id: 'job-1' } }),
      );
    });

    it('should discard the job without retry if the recipient no longer exists (P2003)', async () => {
      const fkError = new Prisma.PrismaClientKnownRequestError(
        'Foreign key constraint failed on the field: `recipientId`',
        { code: 'P2003', clientVersion: 'test' },
      );
      prisma.notification.upsert.mockRejectedValue(fkError);

      await expect(processor.process(makeJob())).resolves.toBeUndefined();
      expect(emailProvider.send).not.toHaveBeenCalled();
    });

    it('should rethrow any other Prisma error so BullMQ retries the job', async () => {
      prisma.notification.upsert.mockRejectedValue(
        new Error('connection lost'),
      );

      await expect(processor.process(makeJob())).rejects.toThrow(
        'connection lost',
      );
    });

    it('should rethrow if the email send fails, so BullMQ retries the job', async () => {
      prisma.notification.upsert.mockResolvedValue({
        id: 'job-1',
        recipient: { email: 'user1@test.com' },
      });
      emailProvider.send.mockRejectedValue(new Error('SMTP timeout'));

      await expect(processor.process(makeJob())).rejects.toThrow(
        'SMTP timeout',
      );
    });
  });

  describe('"send-temporary-password" job', () => {
    it('should send an email containing the temporary password', async () => {
      const job = {
        id: 'job-3',
        name: 'send-temporary-password',
        data: {
          email: 'newuser@test.com',
          firstName: 'Jean',
          temporaryPassword: 'Sup3rSecret!',
        },
      } as Job;

      await processor.process(job);

      expect(emailProvider.send).toHaveBeenCalledWith({
        to: 'newuser@test.com',
        subject: expect.stringContaining('mot de passe temporaire') as string,
        text: expect.stringContaining('Sup3rSecret!') as string,
      });
      expect(prisma.notification.upsert).not.toHaveBeenCalled();
    });
  });

  it('should ignore unknown job names without throwing', async () => {
    const job = { id: 'job-4', name: 'unknown-job', data: {} } as Job;
    await expect(processor.process(job)).resolves.toBeUndefined();
    expect(emailProvider.send).not.toHaveBeenCalled();
  });
});
