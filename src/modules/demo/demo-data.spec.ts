import { BroadcastStatus } from '@prisma/client';
import { haversineDistanceMeters } from '../../common/utils/geo.util';
import {
  DAY,
  DEMO_LATE_THRESHOLD_MINUTES,
  DEMO_POSTER_SITES,
  MINUTE,
  buildBroadcastPlan,
  doualaMidnight,
  offsetCoordinates,
} from './demo-data';

describe('demo data', () => {
  describe('doualaMidnight', () => {
    it('should return local midnight in Douala (UTC+1)', () => {
      // 23:30 UTC = 00:30 le lendemain à Douala.
      const date = new Date('2026-10-13T23:30:00.000Z');
      expect(doualaMidnight(date).toISOString()).toBe(
        '2026-10-13T23:00:00.000Z',
      );
      expect(doualaMidnight(date, -1).toISOString()).toBe(
        '2026-10-12T23:00:00.000Z',
      );
    });
  });

  describe('buildBroadcastPlan', () => {
    const now = new Date('2026-10-13T10:00:00.000Z');
    const plan = (at: Date) =>
      buildBroadcastPlan({
        firstDay: doualaMidnight(at, -21),
        days: 36,
        slots: [
          [7, 15],
          [18, 30],
        ],
        saturdaySlot: [12, 0],
        now: at,
        seed: 42,
        cancelledPastIndexes: [20],
        cancelledFutureIndexes: [4],
      });

    it('should give the monitoring screens meaningful numbers', () => {
      const broadcasts = plan(now);
      const past = broadcasts.filter((b) => b.scheduledAt < now);
      const future = broadcasts.filter((b) => b.scheduledAt >= now);
      const count = (list: typeof broadcasts, status: BroadcastStatus) =>
        list.filter((b) => b.status === status).length;

      // ~2 diffusions par jour, plus le samedi midi.
      expect(broadcasts.length).toBeGreaterThanOrEqual(72);
      expect(broadcasts.length).toBeLessThanOrEqual(80);

      expect(count(past, BroadcastStatus.BROADCASTED)).toBeGreaterThan(
        past.length * 0.8,
      );
      expect(count(past, BroadcastStatus.MISSED)).toBeGreaterThanOrEqual(2);
      expect(count(past, BroadcastStatus.CANCELLED)).toBe(1);
      expect(count(past, BroadcastStatus.PLANNED)).toBe(0);
      expect(count(future, BroadcastStatus.CANCELLED)).toBe(1);
      expect(count(future, BroadcastStatus.PLANNED)).toBe(future.length - 1);

      const late = past.filter(
        (b) =>
          b.actualBroadcastAt &&
          b.actualBroadcastAt.getTime() - b.scheduledAt.getTime() >
            DEMO_LATE_THRESHOLD_MINUTES * MINUTE,
      );
      expect(late.length).toBeGreaterThanOrEqual(3);

      for (const b of broadcasts) {
        if (b.status === BroadcastStatus.BROADCASTED) {
          expect(b.actualBroadcastAt).not.toBeNull();
          expect(b.actualBroadcastAt!.getTime()).toBeLessThanOrEqual(
            now.getTime(),
          );
        } else {
          expect(b.actualBroadcastAt).toBeNull();
        }
      }
    });

    it('should shift with the reset time (dates are relative)', () => {
      const a = plan(now);
      const b = plan(new Date(now.getTime() + 7 * DAY));
      expect(b).toHaveLength(a.length);
      a.forEach((broadcast, i) => {
        expect(
          b[i].scheduledAt.getTime() - broadcast.scheduledAt.getTime(),
        ).toBe(7 * DAY);
        expect(b[i].status).toBe(broadcast.status);
      });
    });

    it('should schedule at Douala local times', () => {
      const [first, second] = plan(now);
      // 07:15 et 18:30 à Douala = 06:15 et 17:30 UTC.
      expect(first.scheduledAt.toISOString().slice(11, 16)).toBe('06:15');
      expect(second.scheduledAt.toISOString().slice(11, 16)).toBe('17:30');
    });
  });

  describe('poster sites', () => {
    it('should place each proof at the intended distance from the planned point', () => {
      for (const site of DEMO_POSTER_SITES.filter((s) => s.proofOffsetMeters)) {
        const point = offsetCoordinates(
          site.latitude,
          site.longitude,
          site.proofOffsetMeters!,
          site.proofBearing!,
        );
        const distance = haversineDistanceMeters(
          site.latitude,
          site.longitude,
          point.latitude,
          point.longitude,
        );
        expect(
          Math.abs(distance - site.proofOffsetMeters!),
        ).toBeLessThanOrEqual(1);
        expect(distance).toBeLessThanOrEqual(150);
      }
    });

    it('should mix validated, pending, rejected and planned installations', () => {
      const states = DEMO_POSTER_SITES.map((s) => s.state);
      expect(states).toHaveLength(8);
      for (const state of [
        'VALIDATED',
        'PENDING_REVIEW',
        'REJECTED',
        'PLANNED',
      ]) {
        expect(states).toContain(state);
      }
      const photos = DEMO_POSTER_SITES.flatMap((s) =>
        s.photo ? [s.photo] : [],
      );
      expect([...photos].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    });
  });
});
