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

const ingredientInput = { ...input, operation: 'ingredients' as const, facts: {} };
const ingredientResult = {
  ...result,
  operation: 'ingredients',
  description: null,
  ingredients: ['Rice', 'Tomato'],
  evidence: {
    source: 'saved_manual_draft',
    snapshotSha256: 'a'.repeat(64),
    sourceSha256: null,
    extractionId: null,
    candidateId: null,
    reviewVersion: null,
  },
};
it('requests saved ingredients without sending browser facts and retains review evidence', async () => {
  const s = setup(ingredientResult);
  expect(await s.api.assistDish(venue, draft, ingredientInput)).toMatchObject({
    operation: 'ingredients',
    ingredients: ['Rice', 'Tomato'],
    approvalRequired: true,
    publishable: false,
    provenance: 'unverified',
    evidence: ingredientResult.evidence,
  });
  expect(JSON.parse(s.send.mock.calls[0]![1]!.body as string)).toEqual(ingredientInput);
});
it('preserves an ingredient abstention without invented fallback ingredients', async () => {
  const s = setup({ ...ingredientResult, status: 'abstained', ingredients: [], evidence: null });
  expect(await s.api.assistDish(venue, draft, ingredientInput)).toMatchObject({
    status: 'abstained',
    ingredients: [],
    evidence: null,
  });
});
it.each([
  {
    operation: 'description',
    ingredients: undefined,
    description: result.description,
    evidence: result.evidence,
  },
  { expectedVersion: 9 },
  { evidence: null },
])('rejects incompatible ingredient response %j', async (mismatch) => {
  const s = setup({ ...ingredientResult, ...mismatch });
  await expect(s.api.assistDish(venue, draft, ingredientInput)).rejects.toMatchObject({
    code: 'invalid_response',
  });
});

const allergenInput = {
  operation: 'allergens' as const,
  expectedVersion: 0,
  requestId: '33333333-3333-4333-8333-333333333333',
  facts: { name: 'Avocado toast', ingredients: ['Sourdough bread', 'Poached egg'] },
};
const allergenResult = {
  ...ingredientResult,
  operation: 'allergens',
  ingredients: undefined,
  allergens: ['egg', 'wheat'],
  evidence: { source: 'model_inference', inputSha256: 'b'.repeat(64) },
};
it('requests AI allergen proposals with the typed dish and keeps them unverified', async () => {
  const { ingredients: _drop, ...body } = allergenResult;
  const s = setup(body);
  expect(await s.api.assistDish(venue, draft, allergenInput)).toMatchObject({
    operation: 'allergens',
    allergens: ['egg', 'wheat'],
    approvalRequired: true,
    publishable: false,
    provenance: 'unverified',
  });
  expect(JSON.parse(s.send.mock.calls[0]![1]!.body as string)).toEqual(allergenInput);
});
it('rejects AI allergen labels outside the supported codes', async () => {
  const { ingredients: _drop, ...body } = allergenResult;
  const s = setup({ ...body, allergens: ['gluten'] });
  await expect(s.api.assistDish(venue, draft, allergenInput)).rejects.toThrow();
});
