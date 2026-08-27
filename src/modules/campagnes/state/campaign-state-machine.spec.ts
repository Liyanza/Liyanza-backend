import { BadRequestException } from '@nestjs/common';
import { CampaignStatus } from '@prisma/client';
import { CampaignStateMachine } from './campaign-state-machine';

describe('CampaignStateMachine', () => {
  describe('validateTransition', () => {
    it('should allow valid transitions', () => {
      const validTransitions = [
        { from: CampaignStatus.DRAFT, to: CampaignStatus.PLANNED },
        { from: CampaignStatus.PLANNED, to: CampaignStatus.IN_PROGRESS },
        { from: CampaignStatus.IN_PROGRESS, to: CampaignStatus.COMPLETED },
        { from: CampaignStatus.IN_PROGRESS, to: CampaignStatus.CANCELLED },
        { from: CampaignStatus.PLANNED, to: CampaignStatus.CANCELLED },
        { from: CampaignStatus.DRAFT, to: CampaignStatus.CANCELLED },
      ];

      for (const { from, to } of validTransitions) {
        expect(() =>
          CampaignStateMachine.validateTransition(from, to),
        ).not.toThrow();
      }
    });

    it('should allow staying in the same status (idempotent)', () => {
      const statuses = Object.values(CampaignStatus);
      for (const status of statuses) {
        expect(() =>
          CampaignStateMachine.validateTransition(status, status),
        ).not.toThrow();
      }
    });

    it('should throw for invalid transitions', () => {
      const invalidTransitions = [
        { from: CampaignStatus.DRAFT, to: CampaignStatus.COMPLETED },
        { from: CampaignStatus.PLANNED, to: CampaignStatus.DRAFT },
        { from: CampaignStatus.IN_PROGRESS, to: CampaignStatus.DRAFT },
        { from: CampaignStatus.COMPLETED, to: CampaignStatus.IN_PROGRESS },
        { from: CampaignStatus.CANCELLED, to: CampaignStatus.PLANNED },
      ];

      for (const { from, to } of invalidTransitions) {
        expect(() => CampaignStateMachine.validateTransition(from, to)).toThrow(
          BadRequestException,
        );
      }
    });
  });

  describe('getNextAllowedStatuses', () => {
    it('should return correct next statuses for DRAFT', () => {
      const next = CampaignStateMachine.getNextAllowedStatuses(
        CampaignStatus.DRAFT,
      );
      expect(next).toContain(CampaignStatus.PLANNED);
      expect(next).toContain(CampaignStatus.CANCELLED);
      expect(next).not.toContain(CampaignStatus.IN_PROGRESS);
      expect(next).not.toContain(CampaignStatus.COMPLETED);
    });

    it('should return correct next statuses for PLANNED', () => {
      const next = CampaignStateMachine.getNextAllowedStatuses(
        CampaignStatus.PLANNED,
      );
      expect(next).toContain(CampaignStatus.IN_PROGRESS);
      expect(next).toContain(CampaignStatus.CANCELLED);
      expect(next).not.toContain(CampaignStatus.DRAFT);
    });

    it('should return correct next statuses for IN_PROGRESS', () => {
      const next = CampaignStateMachine.getNextAllowedStatuses(
        CampaignStatus.IN_PROGRESS,
      );
      expect(next).toContain(CampaignStatus.COMPLETED);
      expect(next).toContain(CampaignStatus.CANCELLED);
      expect(next).not.toContain(CampaignStatus.DRAFT);
      expect(next).not.toContain(CampaignStatus.PLANNED);
    });

    it('should return empty array for COMPLETED', () => {
      const next = CampaignStateMachine.getNextAllowedStatuses(
        CampaignStatus.COMPLETED,
      );
      expect(next).toEqual([]);
    });

    it('should return empty array for CANCELLED', () => {
      const next = CampaignStateMachine.getNextAllowedStatuses(
        CampaignStatus.CANCELLED,
      );
      expect(next).toEqual([]);
    });
  });
});
