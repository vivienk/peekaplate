import { type OwnerDishReport, OwnerDishReportSchema } from '@peekaplate/contracts/owner-report';
import { AuthUnavailableError } from './auth';
import type { PreparedStorage } from './owner-prepare';

export const OWNER_BATCH_MS = 5 * 60_000;
const SETTLE_MS = 60_000;
const MAX_REPORT_BYTES = 2_000_000;

export async function readBatchedOwnerReport(
  venueId: string,
  now: Date,
  storage: PreparedStorage,
  measure: (end: Date) => Promise<OwnerDishReport>,
): Promise<OwnerDishReport> {
  const lastEnd = Math.floor((now.getTime() - SETTLE_MS) / OWNER_BATCH_MS) * OWNER_BATCH_MS;
  const current = await readOrSeal(lastEnd);
  const previous = await readOrSeal(lastEnd - OWNER_BATCH_MS);
  if (!current.summary || !previous.summary) throw new AuthUnavailableError();
  const dailyOpens = current.summary.daily_opens?.current;
  const previousOpens = previous.summary.daily_opens?.current;
  return OwnerDishReportSchema.parse({
    ...current,
    summary: {
      ...current.summary,
      baseline: previous.summary.current,
      ...(dailyOpens && previousOpens
        ? { daily_opens: { current: dailyOpens, baseline: previousOpens } }
        : {}),
    },
  });

  async function readOrSeal(end: number): Promise<OwnerDishReport> {
    const endsAt = new Date(end).toISOString();
    const startsAt = new Date(end - OWNER_BATCH_MS).toISOString();
    const key = `owner-report-batches/v1/${venueId}/${endsAt}.json`;
    const validate = (candidate: unknown) => {
      const report = OwnerDishReportSchema.safeParse(candidate);
      if (
        !report.success ||
        report.data.source !== 'production' ||
        report.data.venue_id !== venueId ||
        report.data.report_metadata.calculation_version !== 'production.batch.v1' ||
        report.data.report_metadata.date_window.start_time !== startsAt ||
        report.data.report_metadata.date_window.end_time !== endsAt ||
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

    const measured = validate(await measure(new Date(end)));
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
}
