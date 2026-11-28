import type { OwnerDishReport } from '@peekaplate/contracts/owner-report';
import { describe, expect, it, vi } from 'vitest';
import { fetchOwnerReportCsv, type ReportState } from './report-api';
import { type ReportLoad, settleReport } from './report-data';
import { UNEEZA_REPORT } from './uneeza-report';

// The sample report is a readonly literal; the hook stores it as a parsed OwnerDishReport.
const ready: ReportState = { kind: 'ready', report: UNEEZA_REPORT as unknown as OwnerDishReport };
const shown = (background: boolean): ReportLoad => ({
  state: ready,
  refreshing: true,
  background,
  refreshFailed: false,
  daily: true,
});

describe('report refresh keeps the last good report only for automatic refreshes', () => {
  it('keeps the shown report when the automatic refresh hits a network error or 503', () => {
    for (const kind of ['error', 'unavailable'] as const) {
      const next = settleReport(shown(true), { kind });
      expect(next.state).toBe(ready);
      expect(next).toMatchObject({ refreshing: false, background: false, refreshFailed: true });
    }
  });

  it('replaces the report at once on sign-out, denied access or an invalid report', () => {
    for (const kind of ['signed_out', 'denied', 'invalid'] as const) {
      const next = settleReport(shown(true), { kind });
      expect(next.state).toEqual({ kind });
      expect(next.refreshFailed).toBe(false);
    }
  });

  it("shows the outcome of the owner's own Refresh, as before", () => {
    const next = settleReport(shown(false), { kind: 'unavailable' });
    expect(next.state).toEqual({ kind: 'unavailable' });
    expect(next.refreshFailed).toBe(false);
  });

  it('clears the failed-refresh flag once a later refresh succeeds', () => {
    const failed = {
      ...settleReport(shown(true), { kind: 'error' }),
      refreshing: true,
      background: true,
    };
    const next = settleReport(failed, ready);
    expect(next).toMatchObject({ state: ready, refreshFailed: false, refreshing: false });
  });

  it('does not keep anything when there was no report on screen yet', () => {
    const next = settleReport({ ...shown(true), state: { kind: 'loading' } }, { kind: 'error' });
    expect(next.state).toEqual({ kind: 'error' });
  });
});

describe('Dish Performance CSV download', () => {
  const VENUE = UNEEZA_REPORT.venue_id;
  const csvResponse = () =>
    new Response('dish_id,dish_name\n', { headers: { 'Content-Type': 'text/csv; charset=utf-8' } });
  const call = (fetch: ReturnType<typeof vi.fn>, accessToken: string | null = 'owner-token') =>
    fetchOwnerReportCsv({
      apiBase: 'https://api.example.test/',
      venueId: VENUE,
      accessToken,
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: new Date('2026-11-27T12:00:00Z'),
    });

  it('reads the existing export endpoint with the owner token, never a token in the link', async () => {
    const fetch = vi.fn(async () => csvResponse());
    const result = await call(fetch);
    expect(result).toMatchObject({
      kind: 'ready',
      filename: `owner-report-${VENUE.toLowerCase()}-2026-11-27.csv`,
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      `https://api.example.test/api/v1/venues/${VENUE}/analytics/dishes/export?source=synthetic`,
    );
    expect(url).not.toContain('token');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer owner-token' });
    expect(init.cache).toBe('no-store');
  });

  it('turns API failures into states, not files', async () => {
    expect(await call(vi.fn(), null)).toEqual({ kind: 'signed_out' });
    for (const [status, kind] of [
      [401, 'signed_out'],
      [403, 'denied'],
      [503, 'unavailable'],
      [500, 'error'],
    ] as const)
      expect(await call(vi.fn(async () => new Response('', { status })))).toEqual({ kind });
    expect(await call(vi.fn(async () => Response.json({ not: 'csv' })))).toEqual({ kind: 'error' });
    expect(
      await call(
        vi.fn(async () => {
          throw new TypeError('offline');
        }),
      ),
    ).toEqual({ kind: 'error' });
  });
});
