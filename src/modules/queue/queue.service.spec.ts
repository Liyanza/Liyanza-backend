import { Test, TestingModule } from '@nestjs/testing';
import { QueueService } from './queue.service';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

describe('QueueService', () => {
  let service: QueueService;
  const mockAdd = jest.fn();
  const mockQueue = { add: mockAdd } as unknown as jest.Mocked<Queue>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QueueService,
        { provide: getQueueToken('notifications'), useValue: mockQueue },
        { provide: getQueueToken('ia-simulation'), useValue: mockQueue },
        { provide: getQueueToken('monitoring-radio'), useValue: mockQueue },
        { provide: getQueueToken('qr-code-scan'), useValue: mockQueue },
      ],
    }).compile();

    service = module.get<QueueService>(QueueService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should add a job to a known queue', async () => {
    const payload = { message: 'test' };
    await service.addJob('notifications', 'send-email', payload);
    expect(mockAdd).toHaveBeenCalledWith('send-email', payload, undefined);
  });

  it('should throw error for unknown queue', async () => {
    await expect(service.addJob('unknown', 'job', {})).rejects.toThrow(
      'Unknown queue: unknown',
    );
  });
});
