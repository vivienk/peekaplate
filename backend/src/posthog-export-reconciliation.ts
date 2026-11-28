export type PostHogExportRun = {
  runId: string;
  intervalStart: string;
  intervalEnd: string;
  status: 'completed' | 'failed';
  expectedEventIds: readonly string[];
  copiedEventIds: readonly string[];
};

export type PostHogReconciliationResult = {
  verifiedThrough: string;
  advanced: boolean;
  blockedBy?: string;
  intervals: Array<{
    runId: string;
    status: 'verified' | 'blocked';
    expectedCount: number;
    copiedCount: number;
    uniqueCopiedCount: number;
    duplicateCount: number;
    reason?: string;
  }>;
};

export function reconcilePostHogExportRuns(
  runs: readonly PostHogExportRun[],
  initialVerifiedThrough: string,
): PostHogReconciliationResult {
  const initialCutoff = Date.parse(initialVerifiedThrough);

  if (!Number.isFinite(initialCutoff)) {
    throw new Error('Initial verified cutoff must be a valid timestamp');
  }

  const runIds = new Set<string>();
  const groups = new Map<string, PostHogExportRun[]>();

  for (const run of runs) {
    if (!run.runId.trim() || runIds.has(run.runId)) {
      throw new Error(`Missing or duplicate export run ID: ${run.runId}`);
    }
    runIds.add(run.runId);

    const start = Date.parse(run.intervalStart);
    const end = Date.parse(run.intervalEnd);

    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
      throw new Error(`Invalid interval boundaries for run ${run.runId}`);
    }

    if ([...run.expectedEventIds, ...run.copiedEventIds].some((id) => !id.trim())) {
      throw new Error(`Run ${run.runId} contains an empty event identity`);
    }

    const key = `${start}/${end}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }

  const ordered = [...groups.values()].sort(
    (a, b) =>
      Date.parse(a[0]!.intervalStart) - Date.parse(b[0]!.intervalStart) ||
      Date.parse(a[0]!.intervalEnd) - Date.parse(b[0]!.intervalEnd),
  );

  let cutoff = initialCutoff;
  let blocked = false;
  let blockedBy: string | undefined;

  const intervals: PostHogReconciliationResult['intervals'] = [];

  for (const [index, group] of ordered.entries()) {
    const first = group[0]!;
    const start = Date.parse(first.intervalStart);
    const end = Date.parse(first.intervalEnd);

    if (end <= cutoff) {
      const run = group[group.length - 1]!;
      const copied = new Set(run.copiedEventIds);

      intervals.push({
        runId: run.runId,
        status: 'verified',
        expectedCount: new Set(run.expectedEventIds).size,
        copiedCount: run.copiedEventIds.length,
        uniqueCopiedCount: copied.size,
        duplicateCount: run.copiedEventIds.length - copied.size,
        reason: 'Interval is already covered by the verified cutoff',
      });
      continue;
    }

    const allCopiedEventIds = group.flatMap((run) => run.copiedEventIds);
    const uniqueCopiedEventIds = new Set(allCopiedEventIds);
    const expectedEventIds = new Set(first.expectedEventIds);

    const expectedKey = JSON.stringify([...expectedEventIds].sort());
    const expectedIdsConsistent = group.every(
      (run) => JSON.stringify([...new Set(run.expectedEventIds)].sort()) === expectedKey,
    );

    let reason: string | undefined;
    let accepted: PostHogExportRun | undefined;
    const next = ordered[index + 1]?.[0];

    if (blocked) {
      reason = 'An earlier interval remains unverified';
    } else if (start !== cutoff) {
      reason =
        start > cutoff
          ? 'Interval gap: verified cutoff cannot advance across missing time'
          : 'Interval overlaps the existing verified cutoff';
    } else if (next && Date.parse(next.intervalStart) < end) {
      reason = 'Distinct export intervals overlap';
    } else if (!expectedIdsConsistent) {
      reason = 'PostHog expected event identities differ across replay attempts';
    } else {
      accepted = [...group].reverse().find((run) => run.status === 'completed');

      if (!accepted) {
        reason = 'No completed export run exists for this interval';
      } else if (
        expectedEventIds.size !== uniqueCopiedEventIds.size ||
        [...expectedEventIds].some((id) => !uniqueCopiedEventIds.has(id)) ||
        [...uniqueCopiedEventIds].some((id) => !expectedEventIds.has(id))
      ) {
        accepted = undefined;
        reason = 'Event identity mismatch between PostHog and Supabase';
      }
    }

    if (accepted) {
      cutoff = end;

      intervals.push({
        runId: accepted.runId,
        status: 'verified',
        expectedCount: expectedEventIds.size,
        copiedCount: allCopiedEventIds.length,
        uniqueCopiedCount: uniqueCopiedEventIds.size,
        duplicateCount: allCopiedEventIds.length - uniqueCopiedEventIds.size,
      });
    } else {
      blocked = true;
      blockedBy ??= `${first.runId}: ${reason}`;

      intervals.push({
        runId: group[group.length - 1]!.runId,
        status: 'blocked',
        expectedCount: expectedEventIds.size,
        copiedCount: allCopiedEventIds.length,
        uniqueCopiedCount: uniqueCopiedEventIds.size,
        duplicateCount: allCopiedEventIds.length - uniqueCopiedEventIds.size,
        ...(reason ? { reason } : {}),
      });
    }
  }

  return {
    verifiedThrough: new Date(cutoff).toISOString(),
    advanced: cutoff > initialCutoff,
    ...(blockedBy ? { blockedBy } : {}),
    intervals,
  };
}
