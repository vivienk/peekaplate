import {
  OWNER_PRODUCTION_BATCH_VERSION,
  OWNER_PRODUCTION_DAY_VERSION,
  type OwnerDishReport,
  OwnerDishReportSchema,
  ownerReportMidnight,
} from '@peekaplate/contracts/owner-report';
import { AuthUnavailableError } from './auth';
import type { PreparedStorage } from './owner-prepare';

export const OWNER_BATCH_MS = 5 * 60_000;
export const OWNER_BATCH_SETTLE_MS = 60_000;
const MAX_REPORT_BYTES = 2_000_000;

export function latestOwnerReportBatchEnd(now: Date): number {
  return Math.floor((now.getTime() - OWNER_BATCH_SETTLE_MS) / OWNER_BATCH_MS) * OWNER_BATCH_MS;
}

export function ownerReportDayWindow(now: Date) {
  const end = new Date(latestOwnerReportBatchEnd(now));
  return {
    start: ownerReportMidnight(end),
    end,
    baselineStart: ownerReportMidnight(end, -1),
  };
}

export function ownerReportDishDayStart(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const midnight = new Date(value);
  if (
    !Number.isFinite(midnight.getTime()) ||
    value !== midnight.toISOString() ||
    midnight.getTime() !== ownerReportMidnight(midnight).getTime()
  ) {
    throw new AuthUnavailableError();
  }
  return midnight;
}

function restaurantCountsOnly(report: OwnerDishReport): OwnerDishReport {
  const missing = { value: null, status: 'MISSING' } as const;
  const restaurantCounts = (metrics: NonNullable<OwnerDishReport['summary']>['current']) => ({
    ...metrics,
    avg_interaction_time_seconds: missing,
    portion_previews_shown: missing,
    verified_orders: missing,
  });
  const summary = report.summary;
  return {
    ...report,
    dishes: [],
    report_metadata: {
      ...report.report_metadata,
      coverage: { total_dishes_monitored: 0, measurable_dishes_count: 0 },
      report_status: 'EMPTY',
    },
    ...(summary
      ? {
          summary: {
            ...summary,
            current: restaurantCounts(summary.current),
            baseline: restaurantCounts(summary.baseline),
          },
        }
      : {}),
  };
}

export async function readBatchedOwnerReport(
  venueId: string,
  now: Date,
  storage: PreparedStorage,
  measure: (end: Date) => Promise<OwnerDishReport>,
  dishDayStart?: Date,
): Promise<OwnerDishReport> {
  const lastEnd = latestOwnerReportBatchEnd(now);
  const expose = (report: OwnerDishReport, end: number) =>
    !dishDayStart || end > dishDayStart.getTime() ? restaurantCountsOnly(report) : report;
  const batch = (end: number) =>
    readOrSeal(
      venueId,
      storage,
      OWNER_PRODUCTION_BATCH_VERSION,
      new Date(end - OWNER_BATCH_MS),
      new Date(end),
      async (cutoff) => expose(await measure(cutoff), end),
    );
  const current = await batch(lastEnd);
  const previous = await batch(lastEnd - OWNER_BATCH_MS);
  if (!current.summary || !previous.summary) throw new AuthUnavailableError();
  const dailyOpens = current.summary.daily_opens?.current;
  const previousOpens = previous.summary.daily_opens?.current;
  const report = {
    ...current,
    summary: {
      ...current.summary,
      baseline: previous.summary.current,
      ...(dailyOpens && previousOpens
        ? { daily_opens: { current: dailyOpens, baseline: previousOpens } }
        : {}),
    },
  };
  // The cutoff governs both response periods, including a previously sealed baseline.
  return OwnerDishReportSchema.parse(expose(report, lastEnd));
}

export function readDailyOwnerReport(
  venueId: string,
  now: Date,
  storage: PreparedStorage,
  measure: (
    window: ReturnType<typeof ownerReportDayWindow>,
    midnightReport?: OwnerDishReport,
  ) => Promise<OwnerDishReport>,
  dishDayStart?: Date,
) {
  const window = ownerReportDayWindow(now);
  const allowDishes = dishDayStart && window.baselineStart >= dishDayStart;
  const expose = (report: OwnerDishReport) => (allowDishes ? report : restaurantCountsOnly(report));
  const seal = (end: Date, read: () => Promise<OwnerDishReport>) =>
    readOrSeal(venueId, storage, OWNER_PRODUCTION_DAY_VERSION, window.start, end, read).then(
      expose,
    );
  const measureMidnight = async () => expose(await measure({ ...window, end: window.start }));
  if (window.start.getTime() === window.end.getTime()) return seal(window.end, measureMidnight);
  return seal(window.end, async () => measure(window, await seal(window.start, measureMidnight)));
}

async function readOrSeal(
  venueId: string,
  storage: PreparedStorage,
  version: string,
  start: Date,
  end: Date,
  measure: (end: Date) => Promise<OwnerDishReport>,
): Promise<OwnerDishReport> {
  const endsAt = end.toISOString();
  const startsAt = start.toISOString();
  const prefix =
    version === OWNER_PRODUCTION_DAY_VERSION
      ? 'owner-report-batches/sf-day-v1'
      : 'owner-report-batches/v1';
  const key = `${prefix}/${venueId}/${endsAt}.json`;
  const validate = (candidate: unknown) => {
    const report = OwnerDishReportSchema.safeParse(candidate);
    if (
      !report.success ||
      report.data.source !== 'production' ||
      report.data.venue_id !== venueId ||
      report.data.report_metadata.calculation_version !== version ||
      report.data.summary?.periods.current.start_time !== startsAt ||
      report.data.summary.periods.current.end_time !== endsAt
    )
      throw new AuthUnavailableError();
    return report.data;
  };
  const read = async () => {
    const object = await storage.get(key);
    if (!object) return null;
    const bytes = await object.arrayBuffer();
    if (bytes.byteLength > MAX_REPORT_BYTES) throw new AuthUnavailableError();
    try {
      return validate(
        JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)),
      );
    } catch {
      throw new AuthUnavailableError();
    }
  };
  const existing = await read();
  if (existing) return existing;

  const measured = validate(await measure(end));
  const bytes = new TextEncoder().encode(JSON.stringify(measured));
  if (bytes.length > MAX_REPORT_BYTES) throw new AuthUnavailableError();
  const created = await storage.put(key, Uint8Array.from(bytes).buffer, {
    onlyIf: { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: 'application/json' },
  });
  if (created) return measured;
  const winner = await read();
  if (!winner) throw new AuthUnavailableError();
  return winner;
}
