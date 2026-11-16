import type { StructuredDishDraft } from '@peekaplate/contracts';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { Bindings } from './index';
import { type DatabaseClient, persistExtractedDrafts } from './ingestion/repository';
import {
  listPendingArtwork,
  MAX_PLACEHOLDER_LABELS,
  placeholderLabels,
  recordArtworkPlaceholders,
} from './ingredient-artwork-placeholders';
import { registerArtworkRoutes } from './ingredient-artwork-routes';

const venue = '11111111-1111-4111-8111-111111111111';
const job = '33333333-3333-4333-8333-333333333333';

describe('ingredient artwork placeholders', () => {
  it('collects normalized unique labels and skips names artwork labels cannot express', () => {
    expect(
      placeholderLabels([
        { ingredients: ['  Coconut Milk ', 'basil', 'Basil'] },
        { ingredients: null },
        {},
        { ingredients: ['Ｊalapeño', '7up', 'x'.repeat(121), 'chili-oil', 42 as never] },
        { ingredients: ['coconut   milk'] },
      ]),
    ).toEqual(['coconut milk', 'basil', 'jalapeño', 'chili-oil']);
  });

  it('records at most the label cap from one job', () => {
    const many = Array.from(
      { length: MAX_PLACEHOLDER_LABELS + 20 },
      (_, i) =>
        `item ${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + (Math.floor(i / 26) % 26))}`,
    );
    expect(placeholderLabels([{ ingredients: many }])).toHaveLength(MAX_PLACEHOLDER_LABELS);
  });

  it('inserts only new labels for the tenant and sends nothing when there are none', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 2 }));
    expect(
      await recordArtworkPlaceholders({ query }, { tenantId: venue, jobId: job, labels: [] }),
    ).toBe(0);
    expect(query).not.toHaveBeenCalled();
    expect(
      await recordArtworkPlaceholders(
        { query },
        { tenantId: venue, jobId: job, labels: ['basil', 'coconut milk'] },
      ),
    ).toBe(2);
    const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('INSERT INTO app_private.ingredient_artwork_placeholder');
    expect(sql).toContain('ON CONFLICT (tenant_id, label) DO NOTHING');
    expect(values).toEqual([venue, job, ['basil', 'coconut milk']]);
  });

  it('lists labels without approved artwork, scoped to the venue in a read-only transaction', async () => {
    const calls: string[] = [];
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        calls.push(sql);
        if (sql.includes('ingredient_artwork_placeholder')) {
          expect(values).toEqual([venue]);
          return { rows: [{ label: 'basil', created_at: new Date('2026-11-16T01:00:00Z') }] };
        }
        return { rows: [] };
      }),
    };
    expect(await listPendingArtwork(client as never, venue)).toEqual([
      { label: 'basil', firstSeenAt: '2026-11-16T01:00:00.000Z' },
    ]);
    expect(calls[0]).toBe('BEGIN READ ONLY');
    expect(calls.some((sql) => sql.includes("set_config('app.tenant_id'"))).toBe(true);
    const read = calls.find((sql) => sql.includes('ingredient_artwork_placeholder')) ?? '';
    expect(read).toContain("c.status = 'approved'");
    expect(read).toContain('c.label IS NULL');
    expect(calls.at(-1)).toBe('COMMIT');
  });

  it('records placeholders inside the draft save transaction, before it commits', async () => {
    const order: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FOR UPDATE')) return { rows: [{ lease_generation: '1' }], rowCount: 1 };
        if (sql.includes('ingredient_artwork_placeholder')) order.push('placeholders');
        if (sql === 'COMMIT;') order.push('commit');
        if (sql.includes('INSERT INTO app_private.dish_drafts')) order.push('draft');
        return { rows: [], rowCount: 1 };
      }),
    };
    const draft = {
      draft_id: 'd1',
      draft_index: 0,
      name: 'Soup',
      price_amount: null,
      price_currency: null,
      ingredients: ['Beans', 'Basil'],
      source_id: 's1',
      source_text: 'Soup',
      code_point_spans: [],
      utf16_spans: [],
      review_warnings: [],
      status: 'needs_review',
    } as unknown as StructuredDishDraft;
    const result = await persistExtractedDrafts(client as unknown as DatabaseClient, {
      tenantId: venue,
      jobId: job,
      claimToken: 'token',
      drafts: [draft],
    });
    expect(order).toEqual(['draft', 'placeholders', 'commit']);
    expect(result.placeholderCount).toBe(1);
  });

  it('a failed placeholder insert rolls the whole save back', async () => {
    const seen: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        seen.push(sql);
        if (sql.includes('FOR UPDATE')) return { rows: [{ lease_generation: '1' }], rowCount: 1 };
        if (sql.includes('ingredient_artwork_placeholder')) throw new Error('db down');
        return { rows: [], rowCount: 1 };
      }),
    };
    await expect(
      persistExtractedDrafts(client as unknown as DatabaseClient, {
        tenantId: venue,
        jobId: job,
        claimToken: 'token',
        drafts: [
          {
            draft_id: 'd1',
            draft_index: 0,
            name: 'Soup',
            ingredients: ['Beans'],
            code_point_spans: [],
            utf16_spans: [],
          } as unknown as StructuredDishDraft,
        ],
      }),
    ).rejects.toThrow('db down');
    expect(seen).toContain('ROLLBACK;');
    expect(seen).not.toContain('COMMIT;');
  });
});

describe('pending artwork route', () => {
  const build = (authorizeVenue = async () => {}) => {
    const app = new Hono<{ Bindings: Bindings }>();
    app.onError((error) =>
      Response.json(
        { error: error.name },
        { status: (error as { status?: number }).status ?? 500 },
      ),
    );
    const db = {
      query: vi.fn(async (sql: string) =>
        sql.includes('ingredient_artwork_placeholder')
          ? { rows: [{ label: 'basil', created_at: '2026-11-16T01:00:00Z' }] }
          : { rows: [] },
      ),
    };
    registerArtworkRoutes(app, {
      verify: async () => 'actor',
      authorizeVenue,
      database: async (_env, work) => work(db as never),
    });
    return { app, db };
  };
  const enabled = { INGREDIENT_ARTWORK_ENABLED: 'true' } as unknown as Bindings;

  it('returns the venue pending labels to authorized staff, never cached', async () => {
    const { app } = build();
    const res = await app.request(
      `/venues/${venue}/ingredient-icons/pending`,
      { headers: { Authorization: 'Bearer t' } },
      enabled,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({
      pending: [{ label: 'basil', firstSeenAt: '2026-11-16T01:00:00.000Z' }],
    });
  });

  it('reads nothing without sign-in, without venue access, or with artwork disabled', async () => {
    const noAuth = build();
    expect(
      (await noAuth.app.request(`/venues/${venue}/ingredient-icons/pending`, {}, enabled)).status,
    ).not.toBe(200);
    expect(noAuth.db.query).not.toHaveBeenCalled();

    const denied = build(async () => {
      throw Object.assign(new Error('forbidden'), { status: 403 });
    });
    const res = await denied.app.request(
      `/venues/${venue}/ingredient-icons/pending`,
      { headers: { Authorization: 'Bearer t' } },
      enabled,
    );
    expect(res.status).toBe(403);
    expect(denied.db.query).not.toHaveBeenCalled();

    const off = build();
    const disabled = await off.app.request(
      `/venues/${venue}/ingredient-icons/pending`,
      { headers: { Authorization: 'Bearer t' } },
      {} as Bindings,
    );
    expect(disabled.status).toBe(404);
    expect(off.db.query).not.toHaveBeenCalled();
  });
});
