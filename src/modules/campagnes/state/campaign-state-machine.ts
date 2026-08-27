import { BadRequestException } from '@nestjs/common';
import { CampaignStatus } from '@prisma/client';

export type AllowedTransition = {
  from: CampaignStatus;
  to: CampaignStatus;
};

export class CampaignStateMachine {
  private static readonly transitions: AllowedTransition[] = [
    { from: CampaignStatus.DRAFT, to: CampaignStatus.PLANNED },
    { from: CampaignStatus.PLANNED, to: CampaignStatus.IN_PROGRESS },
    { from: CampaignStatus.IN_PROGRESS, to: CampaignStatus.COMPLETED },
    { from: CampaignStatus.IN_PROGRESS, to: CampaignStatus.CANCELLED },
    { from: CampaignStatus.PLANNED, to: CampaignStatus.CANCELLED },
    { from: CampaignStatus.DRAFT, to: CampaignStatus.CANCELLED },
  ];

  /**
   * Check if a transition from current status to new status is allowed.
   * Throws BadRequestException if not allowed.
   */
  static validateTransition(
    currentStatus: CampaignStatus,
    newStatus: CampaignStatus,
  ): void {
    if (currentStatus === newStatus) {
      // Allowed to stay same (idempotent)
      return;
    }

    const isAllowed = this.transitions.some(
      (t) => t.from === currentStatus && t.to === newStatus,
    );

    if (!isAllowed) {
      throw new BadRequestException(
        `Invalid status transition from ${currentStatus} to ${newStatus}.`,
      );
    }
  }

  /**
   * Get the next allowed statuses for a given status.
   */
  static getNextAllowedStatuses(
    currentStatus: CampaignStatus,
  ): CampaignStatus[] {
    return this.transitions
      .filter((t) => t.from === currentStatus)
      .map((t) => t.to);
  }
}
