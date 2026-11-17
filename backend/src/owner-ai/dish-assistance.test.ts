import { Hono } from 'hono';
import type { Client } from 'pg';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import extraction from '../../../processing/tests/fixtures/review-candidates/representative-candidates-v2.json';
import { CommandError } from '../dish-command';
import type { Bindings } from '../index';
import { registerDishAssistanceRoutes } from './dish-assistance';

const venue = '11111111-1111-4111-8111-111111111111';
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
const id = '22222222-2222-4222-8222-222222222222';
const input = {
  operation: 'description',
  expectedVersion: 1,
  requestId: '33333333-3333-4333-8333-333333333333',
  facts: { description: 'Rice with tomato. A warm bowl for lunch.' },
};
const provider = (text = '{"selection":{"sourceIndex":0,"start":0,"end":17}}') => ({
  status: 'completed',
  model: 'gpt-6-luna',
  output: [
    {
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text }],
    },
  ],
  usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 },
});
function setup() {
  const state = {
    permission: 'owner',
    version: 1,
    removed: null as string | null,
    missing: false,
    description: input.facts.description,
    ingredients: [] as string[],
    origin: 'manual',
    payload: structuredClone(extraction),
    corrected: {} as Record<string, unknown>,
    reviewStatus: 'pending',
    sourceHash: extraction.source.sha256,
    ingredientReads: 0,
    afterIngredientRead: () => {},
  };
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('staff_membership'))
      return { rows: [{ permission: state.permission }], rowCount: 1 };
    if (sql.includes('dish_drafts')) {
      const result = {
        rows: state.missing
          ? []
          : [
              {
                draft_version: state.version,
                removed_at: state.removed,
                review_status: 'pending',
                description: state.description,
                origin: state.origin,
                manual_fields: { ingredients: { status: 'confirmed', items: state.ingredients } },
                job_id: '44444444-4444-4444-8444-444444444444',
                candidate_id: state.payload.candidates[0]!.candidate_id,
                source_id: state.payload.source.source_id,
                payload: state.payload,
                source_sha256: state.sourceHash,
                job_source_hash: state.payload.source.sha256,
                corrected_fields: state.corrected,
                candidate_status: state.reviewStatus,
                incomplete_fields: [],
                review_version: 1,
              },
            ],
        rowCount: state.missing ? 0 : 1,
      };
      if (sql.includes('extraction_review_session')) {
        state.ingredientReads++;
        state.afterIngredientRead();
      }
      return result;
    }
    return { rows: [], rowCount: 0 };
  });
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(provider()));
  const verify = vi.fn(async () => 'staff');
  const authorizeVenue = vi.fn(async () => {});
  const limit = vi.fn(async () => ({ success: true }));
  const env = {
    APP_ENV: 'local',
    SYNTHETIC_REPORT_VENUE_ID: venue,
    OWNER_AI_DISH_ASSISTANCE_ENABLED: 'true',
    OWNER_AI_OPENAI_API_KEY: 'synthetic',
    OWNER_AI_OPENAI_PROJECT_ID: 'proj_synthetic',
    OWNER_AI_RATE_LIMITER: { limit },
  };
  const app = new Hono<{ Bindings: Bindings }>();
  app.onError((error, c) =>
    c.json({ error: 'denied' }, ('status' in error ? error.status : 500) as 403),
  );
  registerDishAssistanceRoutes(app, {
    verify,
    authorizeVenue,
    database: async (_env, work) => work({ query } as unknown as Client),
    approvedVenues: [venue],
    allowedOrigins: ['http://127.0.0.1:5174'],
    fetchImpl,
  });
  const run = (body: unknown = input, headers: Record<string, string> = {}) =>
    app.request(
      `/venues/${venue}/drafts/${id}/ai/assist`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer staff', 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      },
      env,
    );
  return { state, query, fetchImpl, verify, authorizeVenue, limit, env, run };
}
it('accepts project IDs permitted by protected provisioning for description requests', async () => {
  const s = setup();
  s.env.OWNER_AI_OPENAI_PROJECT_ID = 'proj_synthetic-branch_1';
  expect((await s.run()).status).toBe(200);
  expect(s.fetchImpl).toHaveBeenCalledTimes(1);
});
it('keeps provider failure diagnostics server-only and does not retry', async () => {
  const s = setup();
  s.fetchImpl.mockResolvedValue(
    Response.json(
      { error: { code: 'invalid_api_key', message: 'sk-private-provider-message' } },
      { status: 401 },
    ),
  );
  const response = await s.run();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'service_unavailable' });
  expect(console.warn).toHaveBeenCalledExactlyOnceWith('owner_ai_failure', {
    operation: 'dish_description',
    category: 'provider_http',
    httpStatus: 401,
    providerCode: 'invalid_api_key',
  });
  expect(s.fetchImpl).toHaveBeenCalledTimes(1);
});
it('classifies a rejected local reservation without attributing it to OpenAI', async () => {
  const s = setup();
  s.limit.mockRejectedValue(new Error('private limiter details'));
  const response = await s.run();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'service_unavailable' });
  expect(s.fetchImpl).not.toHaveBeenCalled();
  expect(console.warn).toHaveBeenCalledExactlyOnceWith('owner_ai_failure', {
    operation: 'dish_description',
    category: 'request_budget',
    httpStatus: null,
    providerCode: null,
  });
});
it('classifies a later database failure without blaming valid provider output', async () => {
  const s = setup();
  s.fetchImpl.mockImplementation(async () => {
    s.query.mockRejectedValue(new Error('private database details'));
    return Response.json(provider());
  });
  const response = await s.run();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'service_unavailable' });
  expect(s.fetchImpl).toHaveBeenCalledTimes(1);
  expect(console.warn).toHaveBeenCalledExactlyOnceWith('owner_ai_failure', {
    operation: 'dish_description',
    category: 'internal',
    httpStatus: null,
    providerCode: null,
  });
});
it('reads current membership and tenant-scoped draft before one constrained provider request', async () => {
  const s = setup();
  const response = await s.run();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    status: 'review',
    description: 'Rice with tomato.',
    provenance: 'unverified',
    approvalRequired: true,
    publishable: false,
  });
  expect(s.query).toHaveBeenCalledWith(expect.stringContaining('WHERE tenant_id=$1 AND id=$2'), [
    venue,
    id,
  ]);
  expect(s.authorizeVenue.mock.invocationCallOrder[0]).toBeLessThan(
    s.fetchImpl.mock.invocationCallOrder[0]!,
  );
  expect(s.query.mock.invocationCallOrder[0]).toBeLessThan(
    s.fetchImpl.mock.invocationCallOrder[0]!,
  );
  expect(s.fetchImpl).toHaveBeenCalledTimes(1);
  const body = JSON.parse(String(s.fetchImpl.mock.calls[0]?.[1]?.body));
  expect(body).toMatchObject({ store: false, tools: [], max_output_tokens: 256 });
  expect(JSON.parse(body.input)).toMatchObject({
    offsetUnit: 'utf16_code_unit',
    sources: [expect.objectContaining({ text: input.facts.description })],
  });
  expect(s.query.mock.calls.some(([sql]) => /INSERT|UPDATE|DELETE/.test(sql))).toBe(false);
});
const ingredientInput = { ...input, operation: 'ingredients', facts: {} };
it('returns saved owner ingredients as unverified proposals without provider credentials or calls', async () => {
  const s = setup();
  s.env.OWNER_AI_OPENAI_API_KEY = '';
  s.env.OWNER_AI_OPENAI_PROJECT_ID = '';
  s.state.ingredients = ['Rice', 'Tomato'];
  const response = await s.run(ingredientInput);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    operation: 'ingredients',
    status: 'review',
    ingredients: ['Rice', 'Tomato'],
    evidence: { source: 'saved_manual_draft' },
    provenance: 'unverified',
    approvalRequired: true,
    publishable: false,
  });
  expect(s.fetchImpl).not.toHaveBeenCalled();
  expect(s.limit).not.toHaveBeenCalled();
});
it('abstains for a manual name-only draft instead of inventing a recipe', async () => {
  const s = setup();
  expect(await (await s.run(ingredientInput)).json()).toMatchObject({
    status: 'abstained',
    ingredients: [],
    evidence: null,
  });
  expect(s.fetchImpl).not.toHaveBeenCalled();
});
it('resurfaces only saved extraction proposals with their source identity', async () => {
  const s = setup();
  s.state.origin = 'extracted';
  const candidate = s.state.payload.candidates[0]!;
  Object.assign(candidate.original, { ingredients: ['Rice', 'Tomato'] });
  candidate.missing_fields = candidate.missing_fields.filter((field) => field !== 'ingredients');
  const response = await s.run(ingredientInput);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    ingredients: ['Rice', 'Tomato'],
    evidence: {
      source: 'saved_extraction',
      sourceSha256: extraction.source.sha256,
      extractionId: extraction.extraction_id,
      candidateId: candidate.candidate_id,
      reviewVersion: 1,
    },
    provenance: 'unverified',
    publishable: false,
  });
  expect(s.query).toHaveBeenCalledWith(expect.stringContaining('s.source_sha256=j.source_hash'), [
    venue,
    id,
  ]);
  expect(s.query).toHaveBeenCalledWith(
    expect.stringContaining('s.extraction_id=j.active_review_extraction_id'),
    [venue, id],
  );
  expect(s.fetchImpl).not.toHaveBeenCalled();
  expect(s.query.mock.calls.some(([sql]) => /INSERT|UPDATE|DELETE/.test(sql))).toBe(false);
});
it('uses current owner corrections and never restores a removed original ingredient', async () => {
  const s = setup();
  s.state.origin = 'extracted';
  s.state.corrected = { ingredients: ['Rice'] };
  expect(await (await s.run(ingredientInput)).json()).toMatchObject({
    status: 'review',
    ingredients: ['Rice'],
    evidence: { source: 'saved_owner_correction', sourceSha256: extraction.source.sha256 },
  });
  s.state.corrected = { ingredients: [] };
  expect(await (await s.run(ingredientInput)).json()).toMatchObject({
    status: 'abstained',
    ingredients: [],
  });
});
it('fails closed on a different extraction source or a rejected candidate', async () => {
  const s = setup();
  s.state.origin = 'extracted';
  s.state.corrected = { ingredients: ['Rice'] };
  s.state.sourceHash = 'a'.repeat(64);
  expect(await (await s.run(ingredientInput)).json()).toMatchObject({
    status: 'abstained',
    ingredients: [],
  });
  s.state.sourceHash = extraction.source.sha256;
  s.state.reviewStatus = 'rejected';
  expect(await (await s.run(ingredientInput)).json()).toMatchObject({
    status: 'abstained',
    ingredients: [],
  });
});
it('rejects stale ingredient responses and unauthorized tenant access without spending', async () => {
  const s = setup();
  s.state.ingredients = ['Rice'];
  s.state.afterIngredientRead = () => {
    s.state.version = 2;
  };
  expect((await s.run(ingredientInput)).status).toBe(409);
  s.authorizeVenue.mockRejectedValue(new CommandError('forbidden', 403));
  expect((await s.run(ingredientInput)).status).toBe(403);
  expect(s.fetchImpl).not.toHaveBeenCalled();
});
it('rejects a changed saved ingredient snapshot even if its draft version was not advanced', async () => {
  const s = setup();
  s.state.ingredients = ['Rice'];
  s.state.afterIngredientRead = () => {
    s.state.ingredients = ['Tomato'];
  };
  expect((await s.run(ingredientInput)).status).toBe(409);
  expect(s.fetchImpl).not.toHaveBeenCalled();
});
it.each(['viewer', 'revoked'])(
  'rejects %s ingredient access without reading proposals or spending',
  async (permission) => {
    const s = setup();
    s.state.permission = permission;
    expect((await s.run(ingredientInput)).status).toBe(403);
    expect(s.state.ingredientReads).toBe(0);
    expect(s.fetchImpl).not.toHaveBeenCalled();
  },
);
it.each(['viewer', 'revoked'])('denies %s membership before provider', async (permission) => {
  const s = setup();
  s.state.permission = permission;
  expect((await s.run()).status).toBe(403);
  expect(s.fetchImpl).not.toHaveBeenCalled();
});
it('allows an editor but rejects absent or invalid authentication', async () => {
  const s = setup();
  s.state.permission = 'editor';
  expect((await s.run(undefined, { Authorization: '' })).status).toBe(401);
  expect(s.fetchImpl).not.toHaveBeenCalled();
  expect((await s.run()).status).toBe(200);
});
it('rejects cross-tenant authorization and stale draft versions before provider', async () => {
  const s = setup();
  s.state.version = 2;
  expect((await s.run()).status).toBe(409);
  s.authorizeVenue.mockRejectedValue(new CommandError('forbidden', 403));
  expect((await s.run()).status).toBe(403);
  expect(s.fetchImpl).not.toHaveBeenCalled();
});
it('rechecks membership and draft version after provider wait', async () => {
  const s = setup();
  s.fetchImpl.mockImplementation(async () => {
    s.state.version = 2;
    return Response.json(provider());
  });
  expect((await s.run()).status).toBe(409);
  expect(s.fetchImpl).toHaveBeenCalledTimes(1);
});
it('rejects membership revoked during provider wait', async () => {
  const s = setup();
  s.fetchImpl.mockImplementation(async () => {
    s.state.permission = 'revoked';
    return Response.json(provider());
  });
  expect((await s.run()).status).toBe(403);
});
it('abstains without description evidence and spends nothing', async () => {
  const s = setup();
  s.state.missing = true;
  for (const description of ['', 'Rice with tomato.']) {
    const response = await s.run({
      ...input,
      expectedVersion: 0,
      facts: { description },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'abstained',
      description: null,
    });
  }
  expect(s.fetchImpl).not.toHaveBeenCalled();
  expect(s.limit).not.toHaveBeenCalled();
});
it.each(['ingredients', 'allergens'])(
  'rejects unsupported %s request shapes without spending',
  async (operation) => {
    const s = setup();
    const response = await s.run({
      ...input,
      operation,
    });
    expect(response.status).toBe(400);
    expect(s.fetchImpl).not.toHaveBeenCalled();
  },
);
it('renders description only from selected supplied literals', async () => {
  const s = setup();
  expect(await (await s.run({ ...input, operation: 'description' })).json()).toMatchObject({
    description: 'Rice with tomato.',
  });
});
it('can recover a literal saved description when owner input is empty', async () => {
  const s = setup();
  expect(await (await s.run({ ...input, facts: { description: '' } })).json()).toMatchObject({
    description: 'Rice with tomato.',
    evidence: { source: 'saved_description', start: 0, end: 17, offsetUnit: 'utf16_code_unit' },
  });
});
it.each([
  'Rice without egg. A warm bowl.',
  'Rice may contain milk. A warm bowl.',
  'Vegan rice. A warm bowl.',
  'Rice is gluten-free. A warm bowl.',
  "Rice isn't suitable for everyone. A warm bowl.",
])('abstains from safety and qualification text without spending: %s', async (description) => {
  const s = setup();
  s.state.description = description;
  expect(await (await s.run({ ...input, facts: { description } })).json()).toMatchObject({
    status: 'abstained',
    description: null,
    evidence: null,
  });
  expect(s.fetchImpl).not.toHaveBeenCalled();
});
it('retains UTF-16 offsets around emoji and decimal quantities', async () => {
  const s = setup();
  const sentence = '🍚 Rice serves 2.5 people.';
  const description = `${sentence} A warm bowl for lunch.`;
  s.state.description = description;
  s.fetchImpl.mockResolvedValue(
    Response.json(
      provider(JSON.stringify({ selection: { sourceIndex: 0, start: 0, end: sentence.length } })),
    ),
  );
  expect(await (await s.run({ ...input, facts: { description } })).json()).toMatchObject({
    description: sentence,
    evidence: { end: sentence.length },
  });
});
it('does not replace owner safety qualifications with an older saved description', async () => {
  const s = setup();
  expect(
    await (
      await s.run({ ...input, facts: { description: 'Rice without eggs. A warm bowl.' } })
    ).json(),
  ).toMatchObject({ status: 'abstained' });
  expect(s.fetchImpl).not.toHaveBeenCalled();
});
it('rejects a source description changed during provider wait even without a version increment', async () => {
  const s = setup();
  s.fetchImpl.mockImplementation(async () => {
    s.state.description = 'Changed source.';
    return Response.json(provider());
  });
  expect((await s.run({ ...input, facts: { description: '' } })).status).toBe(409);
});
it('accepts explicit provider abstention without modifying a draft', async () => {
  const s = setup();
  s.fetchImpl.mockResolvedValue(Response.json(provider('{"selection":null}')));
  expect(await (await s.run()).json()).toMatchObject({
    status: 'abstained',
    description: null,
    evidence: null,
  });
});
it.each([
  { ...input, prompt: 'override' },
  { ...input, facts: { description: 'x'.repeat(4001) } },
  {
    ...input,
    facts: { description: 'Rice\u0000' },
  },
  { ...input, facts: { ...input.facts, allergens: ['Gluten'] } },
])('rejects invalid bounded request before provider', async (body) => {
  const s = setup();
  expect((await s.run(body)).status).toBe(400);
  expect(s.fetchImpl).not.toHaveBeenCalled();
});
it('fails closed for production, disabled config, missing limiter and disallowed origin', async () => {
  const s = setup();
  s.env.APP_ENV = 'production';
  expect((await s.run()).status).toBe(503);
  s.env.APP_ENV = 'local';
  s.env.OWNER_AI_DISH_ASSISTANCE_ENABLED = 'false';
  expect((await s.run()).status).toBe(503);
  s.env.OWNER_AI_DISH_ASSISTANCE_ENABLED = 'true';
  expect((await s.run(undefined, { Origin: 'https://untrusted.example' })).status).toBe(403);
  Object.assign(s.env, { OWNER_AI_RATE_LIMITER: undefined });
  expect((await s.run()).status).toBe(503);
  expect(s.fetchImpl).not.toHaveBeenCalled();
});
it('blocks exhausted rate budget before provider', async () => {
  const s = setup();
  s.limit.mockResolvedValue({ success: false });
  expect((await s.run()).status).toBe(429);
  expect(s.fetchImpl).not.toHaveBeenCalled();
});
it('requires the venue in strict server synthetic configuration before provider', async () => {
  const s = setup();
  s.env.SYNTHETIC_REPORT_VENUE_ID = id;
  expect((await s.run()).status).toBe(503);
  s.env.SYNTHETIC_REPORT_VENUE_ID = '';
  expect((await s.run()).status).toBe(503);
  expect(s.fetchImpl).not.toHaveBeenCalled();
});
it.each([
  'not json',
  '{"selection":{"sourceIndex":2,"start":0,"end":17}}',
  '{"selection":{"sourceIndex":0,"start":5,"end":17}}',
  '{"selection":{"sourceIndex":0,"start":0,"end":17},"description":"invented"}',
])('rejects malformed provider selection without retries %s', async (text) => {
  const s = setup();
  s.fetchImpl.mockResolvedValue(Response.json(provider(text)));
  expect((await s.run()).status).toBe(503);
  expect(s.fetchImpl).toHaveBeenCalledTimes(1);
});
it.each([
  { ...provider(), status: 'incomplete' },
  {
    ...provider(),
    output: [
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'refusal', refusal: 'No' }],
      },
    ],
  },
  { ...provider(), model: 'unapproved-model' },
  { ...provider(), usage: { input_tokens: 1, output_tokens: 9999, total_tokens: 10000 } },
])('rejects refusal, truncation, model mismatch and bad usage', async (body) => {
  const s = setup();
  s.fetchImpl.mockResolvedValue(Response.json(body));
  expect((await s.run()).status).toBe(503);
});
it('bounds provider bytes and sanitizes provider/network failures', async () => {
  const s = setup();
  s.fetchImpl.mockResolvedValue(new Response('x'.repeat(32_769)));
  expect((await s.run()).status).toBe(503);
  s.fetchImpl.mockRejectedValue(new Error('private provider error'));
  const response = await s.run();
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('private');
});
