import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { Bindings } from './index';
import { cleanupOrphanedIngredientArtwork } from './ingredient-artwork-retention';
import { registerArtworkRoutes, resolveArtworkBucket } from './ingredient-artwork-routes';

const venue = '11111111-1111-4111-8111-111111111111';
const actor = '22222222-2222-4222-8222-222222222222';
const shaA = 'a'.repeat(64);
const shaB = 'b'.repeat(64);
const shaC = 'c'.repeat(64);

describe('artwork bucket resolution and retention cleanup', () => {
  it('prefers INGREDIENT_ARTWORK_BUCKET and falls back to INGESTION_REPORTS_BUCKET', () => {
    const dedicated = { put: vi.fn() };
    const shared = { put: vi.fn() };
    expect(
      resolveArtworkBucket({
        INGREDIENT_ARTWORK_BUCKET: dedicated,
        INGESTION_REPORTS_BUCKET: shared,
      } as Bindings),
    ).toBe(dedicated);
    expect(resolveArtworkBucket({ INGESTION_REPORTS_BUCKET: shared } as Bindings)).toBe(shared);
    expect(resolveArtworkBucket({} as Bindings)).toBeUndefined();
  });

  it('allows revocation without a bucket binding when INGREDIENT_ARTWORK_ENABLED is true', async () => {
    const app = new Hono<{ Bindings: Bindings }>();
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('SELECT permission')) return { rows: [{ permission: 'owner' }] };
        if (sql.startsWith('SELECT request_hash')) return { rows: [] };
        if (sql.startsWith('SELECT stream_id'))
          return { rows: [{ version: 1, stream_id: crypto.randomUUID() }] };
        return { rows: [] };
      }),
    };
    registerArtworkRoutes(app, {
      verify: async () => actor,
      authorizeVenue: async () => {},
      database: async (_env, work) => work(db as never),
    });

    const res = await app.request(
      `/venues/${venue}/ingredient-icons/review`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commandId: crypto.randomUUID(),
          expectedVersion: 1,
          label: 'coconut',
          status: 'revoked',
          reason: 'Withdraw icon',
        }),
      },
      { INGREDIENT_ARTWORK_ENABLED: 'true' },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      state: { label: 'coconut', version: 2, status: 'revoked', sha256: null },
    });
  });

  it('deletes unreferenced/revoked/superseded objects past grace period while protecting approved, shared, in-flight, and non-artwork keys', async () => {
    const nowMs = Date.UTC(2026, 10, 14, 12, 0, 0);
    const oldDate = new Date(nowMs - 2 * 3_600_000);
    const recentDate = new Date(nowMs - 60_000);
    const deletedKeys: string[] = [];

    const storage = {
      list: vi.fn(async ({ prefix }: { prefix: string }) => {
        expect(prefix).toBe('ingredient-artwork/');
        return {
          objects: [
            { key: `ingredient-artwork/${venue}/${shaA}.png`, uploaded: oldDate }, // approved (shared)
            { key: `ingredient-artwork/${venue}/${shaB}.png`, uploaded: oldDate }, // unreferenced/revoked
            { key: `ingredient-artwork/${venue}/${shaC}.png`, uploaded: recentDate }, // in-flight
            { key: `ingredient-artwork/${venue}/not-a-hash.png`, uploaded: oldDate }, // malformed
            { key: `menu-staging/${venue}/${venue}/${shaB}`, uploaded: oldDate }, // unrelated prefix
          ],
          truncated: false,
        };
      }),
      delete: vi.fn(async (key: string) => {
        deletedKeys.push(key);
      }),
    };

    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM app_private.ingredient_artwork_current')) {
          const sha = params?.[1];
          return sha === shaA
            ? { rowCount: 1, rows: [{ '?column?': 1 }] }
            : { rowCount: 0, rows: [] };
        }
        return { rows: [] };
      }),
    };

    const result = await cleanupOrphanedIngredientArtwork({
      storage,
      client: client as never,
      gracePeriodMs: 3_600_000,
      nowMs,
    });

    expect(deletedKeys).toEqual([`ingredient-artwork/${venue}/${shaB}.png`]);
    expect(result).toEqual({
      scanned: 4,
      deleted: 1,
      protectedApproved: 1,
      protectedInFlight: 1,
      retained: 1,
      errors: 0,
      truncated: false,
    });
  });

  it('bounds batch deletes and continues after partial delete failures for safe retry', async () => {
    const nowMs = Date.UTC(2026, 10, 14, 12, 0, 0);
    const oldDate = new Date(nowMs - 2 * 3_600_000);
    const deletedKeys: string[] = [];

    const storage = {
      list: vi.fn(async () => ({
        objects: [
          { key: `ingredient-artwork/${venue}/${shaA}.png`, uploaded: oldDate },
          { key: `ingredient-artwork/${venue}/${shaB}.png`, uploaded: oldDate },
          { key: `ingredient-artwork/${venue}/${shaC}.png`, uploaded: oldDate },
        ],
        truncated: false,
      })),
      delete: vi.fn(async (key: string) => {
        if (key.includes(shaA)) throw new Error('R2 transient error');
        deletedKeys.push(key);
      }),
    };
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM app_private.ingredient_artwork_current')) {
          return { rowCount: 0, rows: [] };
        }
        return { rows: [] };
      }),
    };

    const result = await cleanupOrphanedIngredientArtwork({
      storage,
      client: client as never,
      gracePeriodMs: 3_600_000,
      maxDeletes: 1,
      nowMs,
    });

    expect(deletedKeys).toEqual([`ingredient-artwork/${venue}/${shaB}.png`]);
    expect(result.errors).toBe(1);
    expect(result.deleted).toBe(1);
    expect(result.truncated).toBe(true);
  });
});
