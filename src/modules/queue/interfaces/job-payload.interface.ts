/**
 * Standardised payload structure for all BullMQ jobs.
 * Not mandatory, but recommended for consistency.
 */
export interface JobPayload<T = any> {
  /** Unique identifier for the job, can be used for idempotency */
  jobId: string;
  /** Actual business payload */
  payload: T;
  /** Optional override for retry attempts */
  attempts?: number;
  /** Optional backoff configuration */
  backoff?: {
    type: 'fixed' | 'exponential';
    delay?: number;
  };
}
