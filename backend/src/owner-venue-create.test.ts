import { Hono } from 'hono';
import type { Client } from 'pg';
import { expect, it, vi } from 'vitest';
import { AuthenticationError } from './auth';
import { CommandError } from './command-error';
import type { Bindings } from './index';
import { createApp } from './index';
import { registerOwnerVenueCreation } from './owner-venue-create';

const actor = '11111111-1111-4111-8111-111111111111';
const commandId = '22222222-2222-4222-8222-222222222222';
const venue = {
  venueId: '33333333-3333-4333-8333-333333333333',
  name: 'Synthetic restaurant',
  permission: 'owner',
};
function fixture(productionOrigin?: string) {
  const state = { failure: '' };
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes('create_owner_venue') || sql.includes('create_first_owner_venue')) {
      if (state.failure)
        throw Object.assign(new Error('Private database detail'), { code: state.failure });
      return { rows: [{ venue }] };
    }
    return { rows: [] };
  });
  const verify = vi.fn(async () => actor);
  const database = vi.fn();
  const app = new Hono<{ Bindings: Bindings }>();
  app.onError((error, c) => {
    if (error instanceof CommandError) return c.json({ error: error.code }, error.status);
    if (error instanceof AuthenticationError) return c.json({ error: 'unauthorized' }, 401);
    return c.json({ error: 'service_unavailable' }, 503);
  });
  registerOwnerVenueCreation(app, {
    verify,
    database: async (env, work) => {
      database(env);
      return work({ query } as unknown as Client);
    },
    allowedOrigins: ['https://console.example.test'],
    ...(productionOrigin ? { productionOrigin } : {}),
  });
  const run = (
    body: unknown = { commandId, name: venue.name },
    env = 'staging',
    headers: Record<string, string> = {},
    suffix = '',
    ownerWorkflowEnabled = 'true',
  ) =>
    app.request(
      `/staff/venues${suffix}`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer synthetic',
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify(body),
      },
      { APP_ENV: env, OWNER_WORKFLOW_ENABLED: ownerWorkflowEnabled },
    );
  return { state, query, verify, database, run };
}

it('requires authentication on the staging self-service restaurant command', async () => {
  const response = await createApp().request(
    '/staff/venues',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commandId: crypto.randomUUID(), name: 'Synthetic restaurant' }),
    },
    { APP_ENV: 'staging' },
  );
  expect(response.status).toBe(401);
});

it('binds the verified actor and normalized name, returning the existing venue descriptor', async () => {
  const s = fixture();
  const response = await s.run({ commandId, name: '  Synthetic restaurant  ' });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ venue });
  expect(s.query).toHaveBeenCalledWith("SELECT set_config('app.actor_id', $1, true)", [actor]);
  expect(s.query).toHaveBeenCalledWith(
    'SELECT app_private.create_owner_venue($1::uuid,$2::text) AS venue',
    [commandId, venue.name],
  );
  expect(s.query).toHaveBeenLastCalledWith('COMMIT');
});
it('is absent outside staging/local even for oversized or authorized requests', async () => {
  const s = fixture();
  expect((await s.run({ commandId, name: 'x'.repeat(3000) }, 'production')).status).toBe(404);
  expect((await s.run(undefined, '')).status).toBe(404);
  expect(s.verify).not.toHaveBeenCalled();
  expect(s.database).not.toHaveBeenCalled();
});
it('restricts production to its console and uses the first-restaurant command', async () => {
  const productionOrigin = 'https://peekaplate.app';
  const s = fixture(productionOrigin);
  expect((await s.run(undefined, 'production')).status).toBe(403);
  expect(
    (await s.run(undefined, 'production', { Origin: productionOrigin }, '', 'false')).status,
  ).toBe(404);
  expect(
    (await s.run(undefined, 'production', { Origin: 'https://console.example.test' })).status,
  ).toBe(403);
  expect((await s.run(undefined, 'staging', { Origin: productionOrigin })).status).toBe(403);
  expect(s.database).not.toHaveBeenCalled();
  const headers = { Origin: productionOrigin };
  const response = await s.run(undefined, 'production', headers);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ venue });
  expect(s.query).toHaveBeenCalledWith(
    'SELECT app_private.create_first_owner_venue($1::uuid,$2::text) AS venue',
    [commandId, venue.name],
  );
  s.state.failure = 'P0004';
  const duplicate = await s.run(undefined, 'production', headers);
  expect(duplicate.status).toBe(409);
  expect(await duplicate.json()).toEqual({ error: 'command_conflict' });
  expect(s.query).toHaveBeenLastCalledWith('ROLLBACK');
});
it.each([
  { commandId, name: 'Cafe', actorId: actor },
  { commandId, name: 'Cafe', venueId: venue.venueId },
  { commandId, name: 'Cafe', permission: 'owner' },
  { commandId: 'invalid', name: 'Cafe' },
  { commandId, name: '' },
  { commandId, name: 'x'.repeat(161) },
  { commandId, name: 'Cafe\u0000' },
])('rejects forged authority or malformed input: %j', async (body) => {
  const s = fixture();
  expect((await s.run(body)).status).toBe(400);
  expect(s.database).not.toHaveBeenCalled();
});
it('rejects invalid credentials, unapproved origins, query parameters and oversized bodies', async () => {
  const s = fixture();
  expect((await s.run(undefined, 'staging', { Authorization: '' })).status).toBe(401);
  s.verify.mockRejectedValueOnce(new AuthenticationError());
  expect((await s.run()).status).toBe(401);
  expect(
    (await s.run(undefined, 'staging', { Origin: 'https://untrusted.example.test' })).status,
  ).toBe(403);
  expect((await s.run(undefined, 'staging', {}, '?actor=forged')).status).toBe(400);
  expect((await s.run({ commandId, name: 'x'.repeat(3000) })).status).toBe(413);
  expect(s.database).not.toHaveBeenCalled();
});
it.each([
  ['P0003', 409, 'command_conflict'],
  ['42501', 403, 'forbidden'],
  ['P0001', 429, 'restaurant_limit_reached'],
  ['08006', 503, 'service_unavailable'],
] as const)('rolls back %s without leaking database details', async (code, status, error) => {
  const s = fixture();
  s.state.failure = code;
  const response = await s.run();
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error });
  expect(s.query).toHaveBeenLastCalledWith('ROLLBACK');
});
it('extends existing staff discovery CORS for the exact console POST', async () => {
  const response = await createApp().request(
    '/staff/venues',
    {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://peekaplate-console-staging.pages.dev',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    },
    { APP_ENV: 'staging' },
  );
  expect(response.status).toBe(204);
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe(
    'https://peekaplate-console-staging.pages.dev',
  );
  expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  expect(response.headers.get('Access-Control-Allow-Headers')?.toLowerCase()).toContain(
    'content-type',
  );
});
