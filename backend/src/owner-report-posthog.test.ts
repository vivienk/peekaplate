import { describe, expect, it, vi } from 'vitest';
import {
  OwnerReportPostHogUnavailableError,
  readLivePostHogOwnerEvents,
} from './owner-report-posthog';

const scope = {
  projectId: '12345',
  readKey: 'phx_unit_test_key',
  venueId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  windowStart: '2026-11-21T00:00:00.000Z',
  windowEnd: '2026-11-21T17:30:13.456Z',
};
const eventId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const publicationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const row = [eventId, publicationId, 'menu_viewed'];

function provider(response: Response) {
  return vi.fn<typeof fetch>().mockResolvedValue(response);
}

describe('production owner report PostHog query', () => {
  it('requests only current UTC venue event identities from the fixed private origin', async () => {
    const fetcher = provider(
      Response.json({
        results: [row, [eventId.toUpperCase(), publicationId.toUpperCase(), 'menu_viewed']],
        columns: ['event_id', 'publication_id', 'event_type'],
        hasMore: false,
        internal: 'unused provider metadata',
      }),
    );
    await expect(readLivePostHogOwnerEvents(scope, fetcher)).resolves.toEqual([
      { eventId, publicationId, eventType: 'menu_viewed' },
    ]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://us.posthog.com/api/projects/12345/query/');
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'manual',
      headers: { Authorization: `Bearer ${scope.readKey}`, 'Content-Type': 'application/json' },
      signal: expect.any(AbortSignal),
    });
    const request = JSON.parse(String(init?.body));
    expect(request.refresh).toBe('force_blocking');
    expect(request.query.kind).toBe('HogQLQuery');
    expect(request.query.values).toEqual({
      venue_id: scope.venueId,
      window_start: '2026-11-21 00:00:00.000',
      window_end: '2026-11-21 17:30:13.456',
    });
    expect(request.query.query).toContain('SELECT DISTINCT toString(uuid) AS event_id');
    expect(request.query.query).toContain(
      'toString(properties.publication_revision_id) AS publication_id',
    );
    expect(request.query.query).toContain('event AS event_type');
    expect(request.query.query).toContain("AND properties.environment = 'production'");
    expect(request.query.query).toContain('AND properties.venue_id = {venue_id}');
    expect(request.query.query).toContain(
      "AND timestamp >= toDateTime64({window_start}, 3, 'UTC')",
    );
    expect(request.query.query).toContain("AND timestamp < toDateTime64({window_end}, 3, 'UTC')");
    expect(request.query.query).toContain('AND properties.event_id = toString(uuid)');
    expect(
      request.query.query
        .split('WHERE event IN (')[1]
        ?.split(')')[0]
        ?.match(/'[^']+'/g),
    ).toEqual([
      "'menu_viewed'",
      "'dish_viewed'",
      "'dish_detail_opened'",
      "'dish_activity_checkpoint'",
      "'dish_compared'",
      "'dish_portion_opened'",
      "'dish_saved'",
    ]);
    expect(request.query.query).toContain('LIMIT 5001');
    expect(request.query.query).not.toContain(scope.venueId);
  });

  it('distinguishes a complete empty provider response and an empty interval at UTC midnight', async () => {
    const fetcher = provider(Response.json({ results: [], hasMore: null }));
    await expect(readLivePostHogOwnerEvents(scope, fetcher)).resolves.toEqual([]);
    await expect(
      readLivePostHogOwnerEvents({ ...scope, windowEnd: scope.windowStart }, fetcher),
    ).resolves.toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    { projectId: '12/34' },
    { readKey: '' },
    { readKey: 'phc_capture_key' },
    { venueId: 'untrusted-venue' },
    { windowEnd: '2026-11-21T10:30:13.456-07:00' },
    { windowEnd: '2026-11-20T23:59:59.999Z' },
    { windowEnd: '2026-11-22T00:00:00.001Z' },
  ])('rejects invalid scope before issuing a provider request', async (change) => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(readLivePostHogOwnerEvents({ ...scope, ...change }, fetcher)).rejects.toThrow(
      OwnerReportPostHogUnavailableError,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('queries the requested sub-day batch with end-exclusive UTC bounds', async () => {
    const fetcher = provider(Response.json({ results: [] }));
    await expect(
      readLivePostHogOwnerEvents(
        {
          ...scope,
          windowStart: '2026-11-21T10:30:00.000Z',
          windowEnd: '2026-11-21T10:35:00.000Z',
        },
        fetcher,
      ),
    ).resolves.toEqual([]);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).query.values).toMatchObject({
      window_start: '2026-11-21 10:30:00.000',
      window_end: '2026-11-21 10:35:00.000',
    });
  });

  it.each([
    { results: [row], hasMore: true },
    { results: Array.from({ length: 5001 }, () => row) },
    { results: [row, ['invalid-event-id', publicationId, 'menu_viewed']] },
    { results: [row, [eventId, 'invalid-publication-id', 'menu_viewed']] },
    { results: [row, [eventId, publicationId, 'dish_unsaved']] },
    { results: [[...row, 'unexpected-column']] },
    { results: [row], columns: ['event_id', 'event_type', 'publication_id'] },
    { results: [row], warnings: ['partial provider results'] },
    { query_status: { complete: false, id: 'provider query ID' } },
    { error: 'private data', results: [] },
  ])('rejects incomplete or malformed provider results as a whole', async (body) => {
    await expect(readLivePostHogOwnerEvents(scope, provider(Response.json(body)))).rejects.toThrow(
      new OwnerReportPostHogUnavailableError(),
    );
  });

  it.each([
    { conflict: [eventId, scope.venueId, 'menu_viewed'] },
    { conflict: [eventId.toUpperCase(), publicationId, 'dish_viewed'] },
  ])('rejects conflicting event identities even when each row is valid', async ({ conflict }) => {
    await expect(
      readLivePostHogOwnerEvents(scope, provider(Response.json({ results: [row, conflict] }))),
    ).rejects.toThrow(new OwnerReportPostHogUnavailableError());
  });

  it('accepts the full row limit with the longest eligible event name', async () => {
    const results = Array.from({ length: 5000 }, (_, index) => [
      `bbbbbbbb-bbbb-4bbb-8bbb-${String(index).padStart(12, '0')}`,
      publicationId,
      'dish_activity_checkpoint',
    ]);
    await expect(
      readLivePostHogOwnerEvents(scope, provider(Response.json({ results }))),
    ).resolves.toHaveLength(5000);
  });

  it.each([301, 403, 429, 500])('sanitizes provider HTTP %s failures', async (status) => {
    const fetcher = provider(new Response('private provider response', { status }));
    await expect(readLivePostHogOwnerEvents(scope, fetcher)).rejects.toThrow(
      new OwnerReportPostHogUnavailableError(),
    );
  });

  it('cancels an oversized streamed provider body and returns a safe error', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(576_001));
      },
      cancel,
    });
    await expect(readLivePostHogOwnerEvents(scope, provider(new Response(body)))).rejects.toThrow(
      new OwnerReportPostHogUnavailableError(),
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('uses a bounded abort signal and sanitizes a timed-out request', async () => {
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(AbortSignal.abort(new DOMException('private error', 'TimeoutError')));
    try {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
        init?.signal?.throwIfAborted();
        return Response.json({ results: [row] });
      });
      await expect(readLivePostHogOwnerEvents(scope, fetcher)).rejects.toThrow(
        new OwnerReportPostHogUnavailableError(),
      );
      expect(timeout).toHaveBeenCalledWith(5_000);
    } finally {
      timeout.mockRestore();
    }
  });
});
