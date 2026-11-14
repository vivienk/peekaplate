import { createHash, randomUUID } from 'node:crypto';
import {
  type DiningMenu,
  DiningMenuSchema,
  type OrderReceipt,
  OrderReceiptSchema,
  type OrderRequest,
  OrderRequestSchema,
  OrderSubmittedPayloadSchema,
} from '@peekaplate/contracts';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import type { Client } from 'pg';

export class DiningError extends Error {
  constructor(
    readonly code: string,
    readonly status: 403 | 404 | 409 | 503,
  ) {
    super(code);
  }
}
export function priceOrder(menu: DiningMenu, input: OrderRequest) {
  if (!menu.acceptingOrders) throw new DiningError('orders_unavailable', 503);
  if (
    menu.publicationId !== input.publicationId ||
    menu.availabilityVersion !== input.availabilityVersion
  )
    throw new DiningError('menu_changed', 409);
  return input.lines.map((line) => {
    const dish = menu.items.find(
      (item) => item.id === line.dishId && item.revisionId === line.revisionId,
    );
    if (!dish) throw new DiningError('menu_changed', 409);
    return { ...line, name: dish.name, unitCents: dish.unitCents };
  });
}
async function scope(client: Client, locationId: string) {
  const result = await client.query<{ venue_id: string; menu_id: string }>(
    'SELECT venue_id, menu_id FROM app_private.dining_location WHERE location_id = $1 AND enabled = true FOR SHARE',
    [locationId],
  );
  const location = result.rows[0];
  if (!location) throw new DiningError('location_unavailable', 404);
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [location.venue_id]);
  return location;
}
async function readMenuInTransaction(
  client: Client,
  locationId: string,
  venueId: string,
  menuId: string,
) {
  const result = await client.query<{
    menu: unknown;
    publication_id: string;
    availability_version: number;
  }>(
    `SELECT catalog.menu, catalog.publication_id, publication.availability_version FROM app_private.dining_catalog catalog
     JOIN app_private.menu_publication_current publication
       ON publication.tenant_id = catalog.tenant_id AND publication.menu_id = catalog.menu_id
       AND publication.publication_id = catalog.publication_id AND publication.status = 'published'
     WHERE catalog.tenant_id = $1 AND catalog.menu_id = $2 FOR SHARE OF catalog, publication`,
    [venueId, menuId],
  );
  if (!result.rows[0]) throw new DiningError('menu_unavailable', 404);
  const menu = DiningMenuSchema.parse(result.rows[0].menu);
  if (
    menu.locationId !== locationId ||
    menu.venueId !== venueId ||
    menu.menuId !== menuId ||
    menu.publicationId !== result.rows[0].publication_id ||
    menu.availabilityVersion !== result.rows[0].availability_version
  )
    throw new DiningError('menu_unavailable', 503);
  return menu;
}
export async function diningMenu(client: Client, locationId: string) {
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL statement_timeout = '5s'");
    const location = await scope(client, locationId);
    const menu = await readMenuInTransaction(
      client,
      locationId,
      location.venue_id,
      location.menu_id,
    );
    await client.query('COMMIT');
    return menu;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
export async function submitDiningOrder(client: Client, locationId: string, raw: OrderRequest) {
  const input = OrderRequestSchema.parse(raw);
  const hash = createHash('sha256')
    .update(
      JSON.stringify({
        locationId,
        ...input,
        lines: [...input.lines].sort((a, b) => a.dishId.localeCompare(b.dishId)),
      }),
    )
    .digest('hex');
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL lock_timeout = '3s'");
    const location = await scope(client, locationId);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `order:${location.venue_id}:${input.commandId}`,
    ]);
    const prior = await client.query<{ request_hash: string; result: unknown }>(
      `SELECT request_hash, result FROM app_private.es_command
       WHERE tenant_id = $1 AND actor_id = $2 AND idempotency_key = $2::text`,
      [location.venue_id, input.commandId],
    );
    if (prior.rows[0]) {
      if (prior.rows[0].request_hash !== hash) throw new DiningError('command_conflict', 409);
      const receipt = OrderReceiptSchema.parse(prior.rows[0].result);
      await client.query('COMMIT');
      return receipt;
    }
    const menu = await readMenuInTransaction(
      client,
      locationId,
      location.venue_id,
      location.menu_id,
    );
    const lines = priceOrder(menu, input);
    const receipt: OrderReceipt = {
      orderId: randomUUID(),
      locationId,
      status: 'submitted',
      paymentStatus: 'unpaid',
      fulfillment: 'pickup',
      currency: 'USD',
      subtotalCents: lines.reduce((sum, l) => sum + l.unitCents * l.quantity, 0),
      createdAt: new Date().toISOString(),
    };
    const eventId = randomUUID();
    const payload = JSON.stringify({
      ...receipt,
      publicationId: input.publicationId,
      availabilityVersion: input.availabilityVersion,
      lines,
    });
    await client.query(
      `INSERT INTO app_private.es_event (id,tenant_id,stream_type,stream_id,version,schema_version,event_type,payload,metadata)
      VALUES ($1,$2,'order',$3,1,1,'order.submitted',$4::jsonb,'{"source":"diner"}')`,
      [eventId, location.venue_id, receipt.orderId, payload],
    );
    await client.query(
      `INSERT INTO app_private.dining_order (tenant_id,order_id,version,receipt,lines) VALUES ($1,$2,1,$3::jsonb,$4::jsonb)`,
      [location.venue_id, receipt.orderId, JSON.stringify(receipt), JSON.stringify(lines)],
    );
    await client.query(
      `INSERT INTO app_private.es_command (id,tenant_id,actor_id,command_type,idempotency_key,payload,request_hash,result)
      VALUES ($1,$2,$3,'order.submit',$3::text,$4::jsonb,$5,$6::jsonb)`,
      [
        randomUUID(),
        location.venue_id,
        input.commandId,
        JSON.stringify(input),
        hash,
        JSON.stringify(receipt),
      ],
    );
    await client.query(
      `INSERT INTO app_private.outbox (id,tenant_id,event_id,topic,payload) VALUES ($1,$2,$3,'order.submitted',$4::jsonb)`,
      [
        randomUUID(),
        location.venue_id,
        eventId,
        JSON.stringify({ orderId: receipt.orderId, eventId }),
      ],
    );
    await client.query('COMMIT');
    return receipt;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
export async function readDiningInbox(client: Client, actorId: string, venueId: string) {
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SELECT set_config('app.actor_id', $1, true)", [actorId]);
    const member = await client.query(
      'SELECT permission FROM app_private.staff_membership WHERE tenant_id=$1 AND actor_id=$2 FOR SHARE',
      [venueId, actorId],
    );
    if (!member.rows[0]) throw new DiningError('forbidden', 403);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [venueId]);
    const result = await client.query(
      'SELECT receipt, lines FROM app_private.dining_order WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100',
      [venueId],
    );
    await client.query('COMMIT');
    return result.rows;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
export type DiningBindings = {
  DINING_ORDERING_ENABLED?: string;
  DINING_RATE_LIMITER?: { limit(input: { key: string }): Promise<{ success: boolean }> };
};
export function createDiningRoutes<E extends DiningBindings>(services: {
  database<T>(env: E, run: (client: Client) => Promise<T>): Promise<T>;
  verify(authorization: string, env: E): Promise<string>;
}) {
  const app = new Hono<{ Bindings: E }>();
  app.use(
    '*',
    cors({
      origin: [
        'https://peekaplate.app',
        'https://pr-162.peekaplate-diner-preview.pages.dev',
        'http://127.0.0.1:5175',
        'http://127.0.0.1:5173',
      ],
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
    }),
  );
  app.use(
    '*',
    bodyLimit({ maxSize: 8192, onError: (c) => c.json({ error: 'body_too_large' }, 413) }),
  );
  app.use('*', async (c, next) => {
    if (c.env?.DINING_ORDERING_ENABLED !== 'true')
      return c.json({ error: 'ordering_unavailable' }, 503);
    await next();
  });
  app.get('/locations/:locationId/menu', async (c) => {
    if (!/^[a-z0-9-]{1,80}$/.test(c.req.param('locationId')))
      return c.json({ error: 'invalid_request' }, 400);
    return c.json(
      await services.database(c.env, (db) => diningMenu(db, c.req.param('locationId'))),
    );
  });
  app.post('/locations/:locationId/orders', async (c) => {
    const locationId = c.req.param('locationId');
    if (!/^[a-z0-9-]{1,80}$/.test(locationId)) return c.json({ error: 'invalid_request' }, 400);
    const limiter = c.env.DINING_RATE_LIMITER;
    if (!limiter) return c.json({ error: 'ordering_unavailable' }, 503);
    const ip = c.req.header('CF-Connecting-IP');
    if (!ip) return c.json({ error: 'ordering_unavailable' }, 503);
    if (!(await limiter.limit({ key: `dining:${ip}` })).success)
      return c.json({ error: 'rate_limited' }, 429);
    const parsed = OrderRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    return c.json(
      await services.database(c.env, (db) => submitDiningOrder(db, locationId, parsed.data)),
      201,
    );
  });
  app.get('/venues/:venueId/orders', async (c) => {
    const venueId = c.req.param('venueId');
    if (!/^[0-9a-f-]{36}$/i.test(venueId)) return c.json({ error: 'invalid_request' }, 400);
    const bearer = c.req.header('Authorization');
    if (!bearer || !/^Bearer \S+$/i.test(bearer)) return c.json({ error: 'unauthorized' }, 401);
    const actor = await services.verify(bearer, c.env);
    return c.json({
      orders: await services.database(c.env, (db) => readDiningInbox(db, actor, venueId)),
    });
  });
  app.onError((error, c) =>
    error instanceof DiningError
      ? c.json({ error: error.code }, error.status)
      : c.json({ error: 'ordering_unavailable' }, 503),
  );
  return app;
}

export function replayDiningOrder(
  events: readonly {
    tenantId: string;
    streamId: string;
    version: number;
    schemaVersion: number;
    eventType: string;
    payload: unknown;
  }[],
) {
  if (!events.length) return null;
  if (events.length !== 1) throw new Error('Unsupported order stream');
  const event = events[0]!;
  if (event.version !== 1 || event.schemaVersion !== 1 || event.eventType !== 'order.submitted')
    throw new Error('Unsupported order event');
  const payload = OrderSubmittedPayloadSchema.parse(event.payload);
  const {
    publicationId: _publication,
    availabilityVersion: _availability,
    lines: _lines,
    ...receiptFields
  } = payload;
  const receipt = OrderReceiptSchema.parse(receiptFields);
  if (receipt.orderId !== event.streamId || receipt.status !== 'submitted')
    throw new Error('Order event identity mismatch');
  return { tenantId: event.tenantId, receipt, lines: _lines };
}
