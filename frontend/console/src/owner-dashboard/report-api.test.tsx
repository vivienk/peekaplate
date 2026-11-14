import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { fetchOwnerReport, type ReportState, reportUrl } from './report-api';
import { ReportView, reportSourceFromEnv } from './report-data';
import { UNEEZA_REPORT } from './uneeza-report';

const API = 'https://api.example.test/';
const VENUE = UNEEZA_REPORT.venue_id;

function respond(status: number, body: unknown = {}) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

function request(fetch: ReturnType<typeof vi.fn>, overrides = {}) {
  return fetchOwnerReport({
    apiBase: API,
    venueId: VENUE,
    accessToken: 'owner-token',
    fetch: fetch as unknown as typeof globalThis.fetch,
    ...overrides,
  });
}

describe('fetchOwnerReport (S3-RES-03)', () => {
  it('asks for the synthetic report with the owner token and no cache', async () => {
    const fetch = respond(200, UNEEZA_REPORT);
    const state = await request(fetch);
    expect(state.kind).toBe('ready');
    expect(fetch).toHaveBeenCalledWith(
      `https://api.example.test/api/v1/venues/${VENUE}/analytics/dishes?source=synthetic`,
      expect.objectContaining({
        method: 'GET',
        cache: 'no-store',
        credentials: 'omit',
        headers: expect.objectContaining({ Authorization: 'Bearer owner-token' }),
      }),
    );
  });

  it('returns the report exactly as the API sent it', async () => {
    const state = await request(respond(200, UNEEZA_REPORT));
    if (state.kind !== 'ready') throw new Error(state.kind);
    expect(state.report).toEqual(UNEEZA_REPORT);
  });

  it('does not call the API without a sign-in or with a malformed restaurant id', async () => {
    const fetch = respond(200, UNEEZA_REPORT);
    expect(await request(fetch, { accessToken: null })).toEqual({ kind: 'signed_out' });
    expect(await request(fetch, { venueId: '../team' })).toEqual({ kind: 'invalid' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'signed_out'],
    [403, 'denied'],
    [503, 'unavailable'],
    [500, 'error'],
    [404, 'error'],
  ])('maps HTTP %i to %s, never to a report', async (status, kind) => {
    expect(await request(respond(status, UNEEZA_REPORT))).toEqual({ kind });
  });

  it('treats a network failure as an error with retry, not as data', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await request(fetch)).toEqual({ kind: 'error' });
  });

  it('rejects a body that is not JSON or not a valid owner report', async () => {
    const notJson = vi.fn(async () => new Response('<html>', { status: 200 }));
    expect(await request(notJson)).toEqual({ kind: 'invalid' });

    // A suppressed cell that carries a number must never be shown.
    const leaky = structuredClone(UNEEZA_REPORT) as unknown as {
      dishes: { metrics: { open_rate: { value: number | null; status: string } } }[];
    };
    const bowl = leaky.dishes[0];
    if (!bowl) throw new Error('fixture has no dishes');
    bowl.metrics.open_rate = { value: 0.2, status: 'SUPPRESSED' };
    expect(await request(respond(200, leaky))).toEqual({ kind: 'invalid' });

    // Cohort counts are internal and must not reach owners.
    const withCohort = structuredClone(UNEEZA_REPORT) as unknown as {
      dishes: { metrics: { open_rate: Record<string, unknown> } }[];
    };
    const soup = withCohort.dishes[1];
    if (!soup) throw new Error('fixture has no second dish');
    soup.metrics.open_rate.eligible_sessions = 300;
    expect(await request(respond(200, withCohort))).toEqual({ kind: 'invalid' });
  });

  it('never shows a report for another restaurant', async () => {
    const other = { ...UNEEZA_REPORT, venue_id: '00000000-0000-4000-8000-000000000123' };
    expect(await request(respond(200, other))).toEqual({ kind: 'invalid' });
  });

  it('builds the URL from a base with or without a trailing slash', () => {
    expect(reportUrl('https://a.test', VENUE)).toBe(reportUrl('https://a.test//', VENUE));
  });
});

describe('Report data page states', () => {
  const html = (state: ReportState, saved = false) =>
    renderToStaticMarkup(<ReportView state={state} saved={saved} onRetry={() => {}} />);

  it('uses the saved copy only when the API settings are missing', () => {
    expect(reportSourceFromEnv({}).mode).toBe('saved');
    expect(reportSourceFromEnv({ VITE_PUBLIC_API_URL: API }).mode).toBe('saved');
    expect(
      reportSourceFromEnv({ VITE_PUBLIC_API_URL: API, VITE_OWNER_REPORT_VENUE_ID: VENUE }).mode,
    ).toBe('live');
  });

  it('labels the saved copy and synthetic live data', async () => {
    const state = await request(respond(200, UNEEZA_REPORT));
    expect(html(state, true)).toContain('Saved copy of a report');
    expect(html(state)).toContain('Synthetic test data from the report API');
    expect(html(state)).not.toContain('Saved copy');
  });

  it('shows the API statuses as labels, not numbers', async () => {
    const page = html(await request(respond(200, UNEEZA_REPORT)));
    expect(page).toContain('Not measurable');
    // Bowl: open rate is a measured zero.
    expect(page).toContain('0%');
  });

  it.each([
    ['loading', 'Loading report'],
    ['signed_out', 'Sign in to see'],
    ['denied', 'have access'],
    ['unavailable', 'aren’t available'],
    ['invalid', 'verify this report'],
    ['error', 'try again'],
  ] as const)('shows %s without any report values', (kind, text) => {
    const page = html({ kind } as ReportState);
    expect(page).toContain(text);
    expect(page).not.toMatch(/<table/);
    expect(page).not.toContain('%');
    expect(page.includes('Try again')).toBe(kind === 'error');
  });
});
