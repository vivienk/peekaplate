import { OwnerDishReportSchema } from '@peekaplate/contracts/owner-report';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchOwnerReport } from '../owner-dashboard/report-api';
import { ReportView } from '../owner-dashboard/report-data';
import { LiveDashboardReport } from './OwnerWorkspace';

const VENUE_A = '11111111-1111-4111-8111-111111111111';
const VENUE_B = '22222222-2222-4222-8222-222222222222';

function buildReport({
  venueId,
  openRate,
  isStale = false,
  windowStart = '2026-11-24T11:50:00.000Z',
  windowEnd = '2026-11-24T11:55:00.000Z',
}: {
  venueId: string;
  openRate: number;
  isStale?: boolean | null;
  windowStart?: string;
  windowEnd?: string;
}) {
  return OwnerDishReportSchema.parse({
    schema_version: 'owner_report.v1',
    venue_id: venueId,
    source: 'production',
    report_metadata: {
      calculation_version: 'production.batch.v1',
      generated_at: windowEnd,
      date_window: { start_time: windowStart, end_time: windowEnd, duration_hours: 1 },
      coverage: { total_dishes_monitored: 1, measurable_dishes_count: 1 },
      freshness: { last_event_ingested_at: windowEnd, is_stale: isStale },
      report_status: 'NORMAL',
    },
    dishes: [
      {
        dish_id: '33333333-3333-4333-8333-333333333333',
        name: venueId === VENUE_A ? 'Venue A Lentil Bowl' : 'Venue B Saffron Rice',
        evidence_state: 'NORMAL',
        metrics: {
          active_sessions: { value: venueId === VENUE_A ? 14 : 16, status: 'NORMAL' },
          avg_interaction_time_seconds: { value: 15, status: 'NORMAL' },
          timing_coverage: { value: 1, status: 'NORMAL' },
          open_rate: { value: openRate, status: 'NORMAL' },
          engagement_rate: { value: 0.5, status: 'NORMAL' },
          save_rate: { value: 0.25, status: 'NORMAL' },
        },
      },
    ],
  });
}

function jsonRes(body: unknown, status = 200, ref = 'ref-1') {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'X-PeekaPlate-Report-Reference': ref },
  });
}

describe('S7-RES-07 dashboard refresh, venue isolation, and cutover checks', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  }, 30_000);

  it('refreshes A from 10/14 (71.4%) to 11/14 (78.6%) while keeping B at 12/16 (75%)', async () => {
    let aCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes(VENUE_A)) {
        aCalls += 1;
        return aCalls === 1
          ? jsonRes(buildReport({ venueId: VENUE_A, openRate: 10 / 14 }), 200, 'ref-a1')
          : jsonRes(buildReport({ venueId: VENUE_A, openRate: 11 / 14 }), 200, 'ref-a2');
      }
      return jsonRes(buildReport({ venueId: VENUE_B, openRate: 12 / 16 }), 200, 'ref-b1');
    });

    const aInitial = await fetchOwnerReport({
      apiBase: 'https://example.test',
      venueId: VENUE_A,
      accessToken: 'tok',
      fetch: fetchMock,
    });
    expect(aInitial.kind).toBe('ready');
    if (aInitial.kind === 'ready') {
      const htmlA1 = renderToStaticMarkup(
        <ReportView state={aInitial} presentation="performance" />,
      );
      expect(htmlA1).toContain('71.4%');
      expect(aInitial.reference).toBe('ref-a1');
    }

    const aRefreshed = await fetchOwnerReport({
      apiBase: 'https://example.test',
      venueId: VENUE_A,
      accessToken: 'tok',
      fetch: fetchMock,
    });
    expect(aRefreshed.kind).toBe('ready');
    if (aRefreshed.kind === 'ready') {
      const htmlA2 = renderToStaticMarkup(
        <ReportView state={aRefreshed} presentation="performance" />,
      );
      expect(htmlA2).toContain('78.6%');
      expect(aRefreshed.reference).toBe('ref-a2');
    }

    const bSnapshot = await fetchOwnerReport({
      apiBase: 'https://example.test',
      venueId: VENUE_B,
      accessToken: 'tok',
      fetch: fetchMock,
    });
    expect(bSnapshot.kind).toBe('ready');
    if (bSnapshot.kind === 'ready') {
      const htmlB = renderToStaticMarkup(
        <ReportView state={bSnapshot} presentation="performance" />,
      );
      expect(htmlB).toContain('75%');
      expect(htmlB).not.toContain('78.6%');
      expect(bSnapshot.reference).toBe('ref-b1');
    }
  }, 30_000);

  it('aborts delayed A requests when switching to B so no A data appears under B', async () => {
    const controllerA = new AbortController();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes(VENUE_A)) {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        });
      }
      return Promise.resolve(
        jsonRes(buildReport({ venueId: VENUE_B, openRate: 12 / 16 }), 200, 'ref-b-fast'),
      );
    });

    const pendingA = fetchOwnerReport({
      apiBase: 'https://example.test',
      venueId: VENUE_A,
      accessToken: 'tok',
      signal: controllerA.signal,
      fetch: fetchMock,
    });
    controllerA.abort();

    const activeB = await fetchOwnerReport({
      apiBase: 'https://example.test',
      venueId: VENUE_B,
      accessToken: 'tok',
      fetch: fetchMock,
    });

    expect(await pendingA).toEqual({ kind: 'error' });
    expect(activeB.kind).toBe('ready');
    if (activeB.kind === 'ready') {
      const html = renderToStaticMarkup(
        <ReportView state={activeB} presentation="performance" />,
      );
      expect(html).toContain('Venue B Saffron Rice');
      expect(html).not.toContain('Venue A Lentil Bowl');
    }
  }, 30_000);

  it('handles stale data, daily UTC cutover, revocation (403), and renders LiveDashboardReport', async () => {
    const staleReport = buildReport({
      venueId: VENUE_A,
      openRate: 10 / 14,
      isStale: true,
      windowStart: '2026-11-24T00:00:00.000Z',
      windowEnd: '2026-11-24T23:55:00.000Z',
    });
    const staleHtml = renderToStaticMarkup(
      <ReportView state={{ kind: 'ready', report: staleReport }} presentation="performance" />,
    );
    expect(staleHtml).toContain('out of date');

    const cutoverReport = buildReport({
      venueId: VENUE_A,
      openRate: 11 / 14,
      isStale: false,
      windowStart: '2026-11-25T00:00:00.000Z',
      windowEnd: '2026-11-25T00:05:00.000Z',
    });
    const cutoverHtml = renderToStaticMarkup(
      <ReportView state={{ kind: 'ready', report: cutoverReport }} presentation="performance" />,
    );
    expect(cutoverHtml).toContain('up to date');
    expect(cutoverHtml).toContain('78.6%');

    const revoked = await fetchOwnerReport({
      apiBase: 'https://example.test',
      venueId: VENUE_A,
      accessToken: 'revoked-tok',
      fetch: async () => new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }),
    });
    expect(revoked).toEqual({ kind: 'denied' });

    const mountedHtml = renderToStaticMarkup(
      <LiveDashboardReport
        reloadAttempt={1}
        page="performance"
        apiBase="https://example.test"
        venueId={VENUE_A}
        restaurantName="Venue A"
        menu={[]}
        getAccessToken={async () => 'tok'}
        onAccessFailure={() => {}}
        onReport={() => {}}
        go={() => {}}
      />,
    );
    expect(mountedHtml).toContain('Loading report…');
  }, 30_000);
});
