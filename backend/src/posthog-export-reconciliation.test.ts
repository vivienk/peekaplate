import { describe, expect, it } from 'vitest';
import { reconcilePostHogExportRuns } from './posthog-export-reconciliation';

const cutoff = '2026-10-24T00:00:00.000Z';
const sunday = '2026-10-25T00:00:00.000Z';
const monday = '2026-10-26T00:00:00.000Z';

describe('reconcilePostHogExportRuns', () => {
  it('does not certify overlapping intervals in either input order', () => {
    const short = {
      runId: 'short',
      intervalStart: cutoff,
      intervalEnd: sunday,
      status: 'completed' as const,
      expectedEventIds: ['event-1'],
      copiedEventIds: ['event-1'],
    };
    const long = { ...short, runId: 'long', intervalEnd: monday };

    for (const runs of [
      [short, long],
      [long, short],
    ]) {
      const result = reconcilePostHogExportRuns(runs, cutoff);
      expect(result.verifiedThrough).toBe(cutoff);
      expect(result.advanced).toBe(false);
      expect(result.blockedBy).toMatch(/overlap/i);
    }
  });

  it('verifies a consecutive interval using event identities', () => {
    const result = reconcilePostHogExportRuns(
      [
        {
          runId: 'run-sunday',
          intervalStart: cutoff,
          intervalEnd: sunday,
          status: 'completed',
          expectedEventIds: ['event-late'],
          copiedEventIds: ['event-late'],
        },
      ],
      cutoff,
    );

    expect(result.verifiedThrough).toBe(sunday);
    expect(result.advanced).toBe(true);
    expect(result.intervals[0]?.status).toBe('verified');
  });

  it('counts duplicate copies without inflating unique events', () => {
    const result = reconcilePostHogExportRuns(
      [
        {
          runId: 'run-replay',
          intervalStart: cutoff,
          intervalEnd: sunday,
          status: 'completed',
          expectedEventIds: ['event-1'],
          copiedEventIds: ['event-1', 'event-1'],
        },
      ],
      cutoff,
    );

    expect(result.verifiedThrough).toBe(sunday);
    expect(result.intervals[0]).toMatchObject({
      expectedCount: 1,
      copiedCount: 2,
      uniqueCopiedCount: 1,
      duplicateCount: 1,
    });
  });

  it('does not advance across a failed interval even if the next succeeds', () => {
    const result = reconcilePostHogExportRuns(
      [
        {
          runId: 'run-failed',
          intervalStart: cutoff,
          intervalEnd: sunday,
          status: 'failed',
          expectedEventIds: ['event-1'],
          copiedEventIds: [],
        },
        {
          runId: 'run-next',
          intervalStart: sunday,
          intervalEnd: monday,
          status: 'completed',
          expectedEventIds: ['event-2'],
          copiedEventIds: ['event-2'],
        },
      ],
      cutoff,
    );

    expect(result.verifiedThrough).toBe(cutoff);
    expect(result.advanced).toBe(false);
    expect(result.blockedBy).toContain('run-failed');
    expect(result.intervals[1]?.status).toBe('blocked');
  });

  it('advances after a failed interval is successfully replayed', () => {
    const result = reconcilePostHogExportRuns(
      [
        {
          runId: 'run-failed',
          intervalStart: cutoff,
          intervalEnd: sunday,
          status: 'failed',
          expectedEventIds: ['event-1'],
          copiedEventIds: [],
        },
        {
          runId: 'run-replay',
          intervalStart: cutoff,
          intervalEnd: sunday,
          status: 'completed',
          expectedEventIds: ['event-1'],
          copiedEventIds: ['event-1', 'event-1'],
        },
        {
          runId: 'run-next',
          intervalStart: sunday,
          intervalEnd: monday,
          status: 'completed',
          expectedEventIds: ['event-2'],
          copiedEventIds: ['event-2'],
        },
      ],
      cutoff,
    );

    expect(result.verifiedThrough).toBe(monday);
    expect(result.advanced).toBe(true);
    expect(result.intervals.map((entry) => entry.status)).toEqual(['verified', 'verified']);
  });

  it('blocks an interval when event identities do not match', () => {
    const result = reconcilePostHogExportRuns(
      [
        {
          runId: 'run-mismatch',
          intervalStart: cutoff,
          intervalEnd: sunday,
          status: 'completed',
          expectedEventIds: ['expected-event'],
          copiedEventIds: ['different-event'],
        },
      ],
      cutoff,
    );

    expect(result.verifiedThrough).toBe(cutoff);
    expect(result.blockedBy).toContain('identity mismatch');
  });

  it('does not advance across a missing interval', () => {
    const result = reconcilePostHogExportRuns(
      [
        {
          runId: 'run-after-gap',
          intervalStart: sunday,
          intervalEnd: monday,
          status: 'completed',
          expectedEventIds: ['event-2'],
          copiedEventIds: ['event-2'],
        },
      ],
      cutoff,
    );

    expect(result.verifiedThrough).toBe(cutoff);
    expect(result.blockedBy).toContain('Interval gap');
  });

  it('rejects duplicate run IDs', () => {
    const run = {
      runId: 'duplicate',
      intervalStart: cutoff,
      intervalEnd: sunday,
      status: 'completed' as const,
      expectedEventIds: [],
      copiedEventIds: [],
    };

    expect(() => reconcilePostHogExportRuns([run, run], cutoff)).toThrow(
      'Missing or duplicate export run ID',
    );
  });
});

describe('replay consistency', () => {
  it('blocks replay when expected PostHog event IDs change', () => {
    const result = reconcilePostHogExportRuns(
      [
        {
          runId: 'run-failed',
          intervalStart: cutoff,
          intervalEnd: sunday,
          status: 'failed',
          expectedEventIds: ['event-original'],
          copiedEventIds: [],
        },
        {
          runId: 'run-replay',
          intervalStart: cutoff,
          intervalEnd: sunday,
          status: 'completed',
          expectedEventIds: ['event-different'],
          copiedEventIds: ['event-different'],
        },
      ],
      cutoff,
    );

    expect(result.verifiedThrough).toBe(cutoff);
    expect(result.intervals[0]?.status).toBe('blocked');
  });

  it('counts copies across failed and successful replay attempts', () => {
    const result = reconcilePostHogExportRuns(
      [
        {
          runId: 'run-partial',
          intervalStart: cutoff,
          intervalEnd: sunday,
          status: 'failed',
          expectedEventIds: ['event-1', 'event-2'],
          copiedEventIds: ['event-1'],
        },
        {
          runId: 'run-replay',
          intervalStart: cutoff,
          intervalEnd: sunday,
          status: 'completed',
          expectedEventIds: ['event-1', 'event-2'],
          copiedEventIds: ['event-1', 'event-2'],
        },
      ],
      cutoff,
    );

    expect(result.verifiedThrough).toBe(sunday);
    expect(result.intervals[0]).toMatchObject({
      expectedCount: 2,
      copiedCount: 3,
      uniqueCopiedCount: 2,
      duplicateCount: 1,
    });
  });
});
