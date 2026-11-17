import { expect, it, vi } from 'vitest';
import { createOwnerMenuClient } from './api';

const venue = '11111111-1111-4111-8111-111111111111';
const draft = '22222222-2222-4222-8222-222222222222';
const input = {
  operation: 'description' as const,
  expectedVersion: 0,
  requestId: '33333333-3333-4333-8333-333333333333',
  facts: { description: 'Rice with tomato. A warm bowl for lunch.' },
};
const result = {
  schemaVersion: 'dish-assistance.v1',
  venueId: venue,
  draftId: draft,
  ...input,
  facts: undefined,
  status: 'review',
  description: 'Rice with tomato.',
  evidence: { source: 'owner_input', start: 0, end: 17, offsetUnit: 'utf16_code_unit' },
  approvalRequired: true,
  publishable: false,
  provenance: 'unverified',
};
function setup(body: unknown = result, status = 200) {
  const send = vi.fn<typeof fetch>(async () => Response.json(body, { status }));
  const api = createOwnerMenuClient({
    baseUrl: 'http://127.0.0.1:8787',
    getToken: () => 'staff',
    fetch: send,
  });
  return { api, send };
}
it('requests bounded dish assistance through authenticated transport', async () => {
  const s = setup();
  expect(await s.api.assistDish(venue, draft, input)).toMatchObject({ provenance: 'unverified' });
  expect(s.send.mock.calls[0]?.[0]).toBe(
    `http://127.0.0.1:8787/venues/${venue}/drafts/${draft}/ai/assist`,
  );
  expect(s.send.mock.calls[0]?.[1]).toMatchObject({
    method: 'POST',
    headers: { Authorization: 'Bearer staff' },
  });
});
it.each([
  { draftId: venue },
  { requestId: venue },
  { operation: 'allergens' },
  { expectedVersion: 1 },
])('rejects mismatched assistance correlation %j', async (mismatch) => {
  const s = setup({ ...result, ...mismatch });
  await expect(s.api.assistDish(venue, draft, input)).rejects.toMatchObject({
    code: 'invalid_response',
  });
});
it('preserves caller input on provider failure without retries', async () => {
  const s = setup({ error: 'service_unavailable' }, 503);
  const before = JSON.stringify(input);
  await expect(s.api.assistDish(venue, draft, input)).rejects.toMatchObject({ status: 503 });
  expect(JSON.stringify(input)).toBe(before);
  expect(s.send).toHaveBeenCalledTimes(1);
});
it('rejects response text that does not match the cited owner-input slice', async () => {
  const s = setup({ ...result, description: 'Fake with tomato.' });
  await expect(s.api.assistDish(venue, draft, input)).rejects.toMatchObject({
    code: 'invalid_response',
  });
});
