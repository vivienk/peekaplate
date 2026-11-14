import { type DiningMenu, OrderRequestSchema } from '@peekaplate/contracts';
import type { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  createDiningRoutes,
  type DiningBindings,
  priceOrder,
  readDiningInbox,
  replayDiningOrder,
  submitDiningOrder,
} from './dining';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const menu: DiningMenu = {
  locationId: 'noka-oakland',
  venueId: id(1),
  menuId: id(2),
  publicationId: id(3),
  availabilityVersion: 1,
  currency: 'USD',
  acceptingOrders: true,
  items: [
    {
      id: id(4),
      revisionId: id(5),
      name: 'Synthetic test dish',
      description: 'Test only',
      unitCents: 2100,
      image: null,
    },
  ],
};
const input = {
  commandId: id(6),
  publicationId: id(3),
  availabilityVersion: 1,
  fulfillment: 'pickup' as const,
  lines: [{ dishId: id(4), revisionId: id(5), quantity: 2 }],
};
function database(fail = false) {
  const statements: string[] = [];
  let receipt: { request_hash: string; result: unknown } | undefined;
  const client = {
    async query(sql: string, args: unknown[] = []) {
      statements.push(sql);
      if (sql.startsWith('SELECT venue_id')) return { rows: [{ venue_id: id(1), menu_id: id(2) }] };
      if (sql.includes('SELECT catalog.menu'))
        return {
          rows: [
            {
              menu,
              publication_id: menu.publicationId,
              availability_version: menu.availabilityVersion,
            },
          ],
        };
      if (sql.includes('SELECT request_hash')) return { rows: receipt ? [receipt] : [] };
      if (sql.includes('INSERT INTO app_private.es_command'))
        receipt = { request_hash: args[4] as string, result: JSON.parse(args[5] as string) };
      if (fail && sql.includes('INSERT INTO app_private.outbox')) throw new Error('DB failure');
      return { rows: [] };
    },
  } as unknown as Client;
  return { client, statements };
}
describe('order authority and transaction', () => {
  it('rejects client prices, duplicate lines, empty carts and stale revisions', () => {
    expect(OrderRequestSchema.safeParse({ ...input, total: 1 }).success).toBe(false);
    expect(OrderRequestSchema.safeParse({ ...input, lines: [] }).success).toBe(false);
    expect(
      OrderRequestSchema.safeParse({ ...input, lines: [input.lines[0], input.lines[0]] }).success,
    ).toBe(false);
    expect(() => priceOrder(menu, { ...input, publicationId: id(8) })).toThrow('menu_changed');
    expect(() => priceOrder(menu, { ...input, availabilityVersion: 2 })).toThrow('menu_changed');
    expect(() => priceOrder({ ...menu, acceptingOrders: false }, input)).toThrow(
      'orders_unavailable',
    );
    expect(() =>
      priceOrder(menu, { ...input, lines: [{ ...input.lines[0]!, revisionId: id(8) }] }),
    ).toThrow('menu_changed');
    expect(priceOrder(menu, input)[0]!.unitCents).toBe(2100);
  });
  it('commits receipt, event, projection and outbox atomically; duplicate retry writes once', async () => {
    const db = database();
    const result = await submitDiningOrder(db.client, 'noka-oakland', input);
    expect(result.subtotalCents).toBe(4200);
    expect(result.status).toBe('submitted');
    expect(await submitDiningOrder(db.client, 'noka-oakland', input)).toEqual(result);
    expect(
      db.statements.filter((s) => s.includes('INSERT INTO app_private.es_event')),
    ).toHaveLength(1);
    expect(db.statements.at(-1)).toBe('COMMIT');
    await expect(
      submitDiningOrder(db.client, 'noka-oakland', {
        ...input,
        lines: [{ ...input.lines[0]!, quantity: 3 }],
      }),
    ).rejects.toThrow('command_conflict');
  });
  it('never returns a receipt after a failed outbox write', async () => {
    const db = database(true);
    await expect(submitDiningOrder(db.client, 'noka-oakland', input)).rejects.toThrow('DB failure');
    expect(db.statements.at(-1)).toBe('ROLLBACK');
    expect(db.statements).not.toContain('COMMIT');
  });
  it('denies inbox access without venue membership', async () => {
    const db = database();
    await expect(readDiningInbox(db.client, id(7), id(1))).rejects.toThrow('forbidden');
    expect(db.statements.some((s) => s.includes('SELECT receipt'))).toBe(false);
  });
});
describe('order routes fail closed', () => {
  const app = createDiningRoutes<DiningBindings>({
    database: async (_env, work) => work(database().client),
    verify: async () => id(7),
  });
  it('is disabled by default and requires rate limiting for submissions', async () => {
    expect((await app.request('/locations/noka-oakland/menu', {}, {})).status).toBe(503);
    expect(
      (
        await app.request(
          '/locations/noka-oakland/orders',
          { method: 'POST' },
          { DINING_ORDERING_ENABLED: 'true' },
        )
      ).status,
    ).toBe(503);
  });
  it('submits unpaid requests only with valid input and configured receiving backend', async () => {
    const env = {
      DINING_ORDERING_ENABLED: 'true',
      DINING_RATE_LIMITER: { limit: async () => ({ success: true }) },
    };
    const response = await app.request(
      '/locations/noka-oakland/orders',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1' },
        body: JSON.stringify(input),
      },
      env,
    );
    expect(response.status).toBe(201);
    expect(((await response.json()) as { paymentStatus: string }).paymentStatus).toBe('unpaid');
    expect((await app.request('/venues/' + id(1) + '/orders', {}, env)).status).toBe(401);
  });
});

it('replays only a valid v1 submitted order without effects', () => {
  const receipt = {
    orderId: id(9),
    locationId: 'noka-oakland',
    status: 'submitted',
    paymentStatus: 'unpaid',
    fulfillment: 'pickup',
    currency: 'USD',
    subtotalCents: 4200,
    createdAt: '2026-11-14T12:00:00.000Z',
  };
  const event = {
    tenantId: id(1),
    streamId: id(9),
    version: 1,
    schemaVersion: 1,
    eventType: 'order.submitted',
    payload: {
      ...receipt,
      publicationId: id(3),
      availabilityVersion: 1,
      lines: priceOrder(menu, input),
    },
  };
  expect(replayDiningOrder([event])?.receipt).toEqual(receipt);
  expect(() => replayDiningOrder([{ ...event, version: 2 }])).toThrow();
  expect(() =>
    replayDiningOrder([{ ...event, payload: { ...event.payload, subtotalCents: 1 } }]),
  ).toThrow();
  expect(() => replayDiningOrder([{ ...event, streamId: id(8) }])).toThrow();
});
