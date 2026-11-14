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
