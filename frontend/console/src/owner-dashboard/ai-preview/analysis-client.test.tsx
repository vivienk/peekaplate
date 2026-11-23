import { expect, it, vi } from 'vitest';
import { createOwnerAnalysisClient } from './analysis-client';

const venueId = '00000000-0000-4000-8000-000000000123';
const dishId = '00000000-0000-4000-8000-000000000456';
const result = {
  schemaVersion: 'owner-analysis.v1',
  venueId,
  dishId,
  goal: 'menu',
  source: 'synthetic',
  reportSnapshot: 'a'.repeat(64),
  timeWindow: { start: '2026-11-11T12:00:00Z', end: '2026-11-12T12:00:00Z' },
  status: 'review',
  metric: 'open_rate',
  value: 0.5,
  reason: 'review_evidence',
  approvalRequired: true,
  allowedEffects: [],
};
function setup(body: unknown = result, token: string | null = 'synthetic-owner-session') {
  const fetchImpl = vi.fn(async () => Response.json(body));
  const analyze = createOwnerAnalysisClient({
    baseUrl: 'http://127.0.0.1:5174/__owner-ai',
    venueId,
    getAccessToken: async () => token,
    fetchImpl: fetchImpl as typeof fetch,
  });
  return { analyze, fetchImpl };
}
it('uses an owner session and sends only dish/goal with no cookies or persistence', async () => {
  const { analyze, fetchImpl } = setup();
  expect(await analyze({ dishId, goal: 'menu' }, new AbortController().signal)).toEqual(result);
  const [url, init] = (fetchImpl.mock.calls as unknown as [string, RequestInit][])[0]!;
  expect(url).toBe(`http://127.0.0.1:5174/__owner-ai/api/v1/venues/${venueId}/ai/analysis`);
  expect(init).toMatchObject({ credentials: 'omit', cache: 'no-store', redirect: 'error' });
  expect(JSON.parse(init.body as string)).toEqual({ dishId, goal: 'menu' });
});
it('does not send a request without a signed-in session', async () => {
  const { analyze, fetchImpl } = setup(result, null);
  await expect(analyze({ dishId, goal: 'menu' }, new AbortController().signal)).rejects.toThrow();
  expect(fetchImpl).not.toHaveBeenCalled();
});
it('accepts only production evidence from the production API', async () => {
  const valid = { ...result, source: 'production' };
  const request = { dishId, goal: 'menu' } as const;
  const analyze = createOwnerAnalysisClient({
    baseUrl: 'https://api.peekaplate.app',
    venueId,
    getAccessToken: async () => 'owner-session',
    fetchImpl: vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(valid))
      .mockResolvedValueOnce(Response.json(result)),
  });
  await expect(analyze(request, new AbortController().signal)).resolves.toEqual(valid);
  await expect(analyze(request, new AbortController().signal)).rejects.toThrow(
    'Analysis unavailable',
  );
});
it('forwards the displayed report reference in a header without changing dish/goal', async () => {
  const { analyze, fetchImpl } = setup();
  await analyze({ dishId, goal: 'menu' }, new AbortController().signal, 'signed.report.reference');
  const [, init] = (fetchImpl.mock.calls as unknown as [string, RequestInit][])[0]!;
  expect(new Headers(init.headers).get('X-Owner-Report-Ref')).toBe('signed.report.reference');
  expect(JSON.parse(init.body as string)).toEqual({ dishId, goal: 'menu' });
});
it('rejects unsupported API destinations before reading a staff credential', async () => {
  const getAccessToken = vi.fn(async () => 'private-session');
  const fetchImpl = vi.fn(async () => Response.json(result));
  for (const baseUrl of [
    'https://unapproved.example',
    'https://peekaplate-api-staging.vxkong.workers.dev/other',
    'http://127.0.0.1:5174/other',
  ]) {
    const analyze = createOwnerAnalysisClient({ baseUrl, venueId, getAccessToken, fetchImpl });
    await expect(analyze({ dishId, goal: 'menu' }, new AbortController().signal)).rejects.toThrow();
  }
  expect(getAccessToken).not.toHaveBeenCalled();
  expect(fetchImpl).not.toHaveBeenCalled();
});
it.each([401, 403])('preserves access denial %i for the workspace', async (status) => {
  const analyze = createOwnerAnalysisClient({
    baseUrl: 'https://peekaplate-api-staging.vxkong.workers.dev',
    venueId,
    getAccessToken: async () => 'session',
    fetchImpl: async () => Response.json({ error: 'denied' }, { status }),
  });
  await expect(
    analyze({ dishId, goal: 'menu' }, new AbortController().signal),
  ).rejects.toMatchObject({ status });
});
it('identifies an expired or mismatched report reference for explicit report reload', async () => {
  const fetchImpl = vi.fn(async () =>
    Response.json({ error: 'report_reference_unavailable' }, { status: 409 }),
  );
  const analyze = createOwnerAnalysisClient({
    baseUrl: 'https://peekaplate-api-staging.vxkong.workers.dev',
    venueId,
    getAccessToken: async () => 'session',
    fetchImpl,
  });
  await expect(
    analyze({ dishId, goal: 'menu' }, new AbortController().signal, 'expired.reference'),
  ).rejects.toMatchObject({ name: 'OwnerAnalysisReferenceError' });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
it('does not classify an unrelated conflict as an expired reference', async () => {
  const analyze = createOwnerAnalysisClient({
    baseUrl: 'https://peekaplate-api-staging.vxkong.workers.dev',
    venueId,
    getAccessToken: async () => 'session',
    fetchImpl: async () => Response.json({ error: 'other_conflict' }, { status: 409 }),
  });
  await expect(
    analyze({ dishId, goal: 'menu' }, new AbortController().signal),
  ).rejects.toMatchObject({ name: 'Error', message: 'Analysis unavailable' });
});
it('does not dispatch after cancellation during session lookup', async () => {
  const controller = new AbortController();
  const fetchImpl = vi.fn(async () => Response.json(result));
  const analyze = createOwnerAnalysisClient({
    baseUrl: 'https://peekaplate-api-staging.vxkong.workers.dev',
    venueId,
    getAccessToken: async () => {
      controller.abort();
      return 'session';
    },
    fetchImpl,
  });
  await expect(analyze({ dishId, goal: 'menu' }, controller.signal)).rejects.toThrow();
  expect(fetchImpl).not.toHaveBeenCalled();
});
it.each([
  { venueId: dishId },
  { dishId: venueId },
  { goal: 'crm' },
  { allowedEffects: ['publish'] },
  { approvalRequired: false },
  { secret: 'unexpected' },
  { status: 'abstained' },
])('rejects mismatched or unsafe response %j', async (change) => {
  const { analyze } = setup({ ...result, ...change });
  await expect(analyze({ dishId, goal: 'menu' }, new AbortController().signal)).rejects.toThrow();
});
