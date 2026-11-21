import { type OwnerVenue, OwnerVenueSchema } from '@peekaplate/contracts';
import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Client } from 'pg';
import { z } from 'zod';
import { AuthUnavailableError } from './auth';
import { CommandError } from './command-error';
import type { Bindings } from './index';
import { ownerWorkflowAvailable } from './owner-workflow-environment';

const inputSchema = z.strictObject({
  commandId: z.uuid(),
  name: z
    .string()
    .trim()
    .min(1)
    .max(160)
    .refine((name) => !/[\u0000-\u001f\u007f]/.test(name)),
});
type Creation = z.infer<typeof inputSchema>;
export class RestaurantLimitError extends Error {
  readonly status = 429;
}

/** The verifier supplies actor authority; the database allocates the tenant and owner atomically. */
export async function createOwnerVenue(
  client: Client,
  actor: string,
  input: Creation,
  firstOnly = false,
): Promise<OwnerVenue> {
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SELECT set_config('app.actor_id', $1, true)", [actor]);
    await client.query("SELECT set_config('app.tenant_id', '', true)");
    const result = await client.query<{ venue: unknown }>(
      firstOnly
        ? 'SELECT app_private.create_first_owner_venue($1::uuid,$2::text) AS venue'
        : 'SELECT app_private.create_owner_venue($1::uuid,$2::text) AS venue',
      [input.commandId, input.name],
    );
    const venue = OwnerVenueSchema.parse(result.rows[0]?.venue);
    if (venue.permission !== 'owner') throw new AuthUnavailableError();
    await client.query('COMMIT');
    return venue;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'P0003' || code === 'P0004') throw new CommandError('command_conflict', 409);
    if (code === '42501') throw new CommandError('forbidden', 403);
    if (code === 'P0001') throw new RestaurantLimitError('restaurant_limit_reached');
    throw error;
  }
}

export function registerOwnerVenueCreation(
  app: Hono<{ Bindings: Bindings }>,
  services: {
    verify(authorization: string, env: Bindings): Promise<string>;
    database<T>(env: Bindings, work: (client: Client) => Promise<T>): Promise<T>;
    allowedOrigins: readonly string[];
    productionOrigin?: string;
  },
) {
  const limit = bodyLimit({
    maxSize: 2048,
    onError: (c) => c.json({ error: 'body_too_large' }, 413),
  });
  app.use('/staff/venues', async (c, next) => {
    if (c.req.method !== 'POST') return next();
    const stage = c.env?.APP_ENV ?? '';
    if (!ownerWorkflowAvailable(c.env) || (stage === 'production' && !services.productionOrigin))
      return c.json({ error: 'not_found' }, 404);
    return limit(c, next);
  });
  app.post('/staff/venues', async (c) => {
    const authorization = c.req.header('Authorization');
    if (!authorization || !/^Bearer \S+$/i.test(authorization))
      return c.json({ error: 'unauthorized' }, 401);
    const actor = await services.verify(authorization, c.env);
    const origin = c.req.header('Origin');
    const production = c.env.APP_ENV === 'production';
    if (
      production
        ? origin !== services.productionOrigin
        : origin && !services.allowedOrigins.includes(origin)
    )
      return c.json({ error: 'forbidden' }, 403);
    if (
      new URL(c.req.url).search ||
      !/^application\/json(?:\s*;|$)/i.test(c.req.header('Content-Type') ?? '')
    )
      return c.json({ error: 'invalid_request' }, 400);
    const input = inputSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: 'invalid_request' }, 400);
    try {
      return c.json({
        venue: await services.database(c.env, (client) =>
          createOwnerVenue(client, actor, input.data, production),
        ),
      });
    } catch (error) {
      if (error instanceof RestaurantLimitError)
        return c.json({ error: 'restaurant_limit_reached' }, 429);
      throw error;
    }
  });
}
