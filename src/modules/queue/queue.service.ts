import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, JobsOptions } from 'bullmq';

@Injectable()
export class QueueService {
  private readonly queues: Map<string, Queue>;

  constructor(
    @InjectQueue('notifications') private notificationsQueue: Queue,
    @InjectQueue('ia-simulation') private iaSimulationQueue: Queue,
    @InjectQueue('monitoring-radio') private monitoringRadioQueue: Queue,
    @InjectQueue('qr-code-scan') private qrCodeScanQueue: Queue,
  ) {
    this.queues = new Map([
      ['notifications', this.notificationsQueue],
      ['ia-simulation', this.iaSimulationQueue],
      ['monitoring-radio', this.monitoringRadioQueue],
      ['qr-code-scan', this.qrCodeScanQueue],
    ]);
  }

  /**
   * Add a job to the specified queue with a standardized payload.
   * @param queueName - one of: notifications, ia-simulation, monitoring-radio, qr-code-scan
   * @param jobName - logical name of the job (e.g. 'send-email', 'run-simulation')
   * @param payload - data to be processed
   * @param options - additional BullMQ job options (override defaults)
   */
  async addJob<T = any>(
    queueName: string,
    jobName: string,
    payload: T,
    options?: JobsOptions,
  ): Promise<void> {
    const queue = this.queues.get(queueName);
    if (!queue) {
      throw new Error(`Unknown queue: ${queueName}`);
    }
    await queue.add(jobName, payload, options);
  }

  /**
   * Direct access to a queue instance (use with caution).
   */
  getQueue(name: string): Queue | undefined {
    return this.queues.get(name);
  }
}
