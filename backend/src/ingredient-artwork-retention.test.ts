import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { type Bindings, handleScheduled, parseNonNegativeIntEnv } from './index';
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

  it('batches DB checks per page/venue and protects approved, shared, in-flight, and non-artwork keys', async () => {
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
        if (sql.includes('SELECT DISTINCT sha256')) {
          const hashes = (params?.[1] as string[]) ?? [];
          return { rows: hashes.includes(shaA) ? [{ sha256: shaA }] : [] };
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
      pagesScanned: 1,
      deleted: 1,
      protectedApproved: 1,
      protectedInFlight: 1,
      retained: 1,
      errors: 0,
      truncated: false,
    });
  });

  it('bounds thousands of approved objects with maxScanned, maxPages, and dryRun', async () => {
    const nowMs = Date.UTC(2026, 10, 14, 12, 0, 0);
    const oldDate = new Date(nowMs - 2 * 3_600_000);
    const page1 = Array.from({ length: 1000 }, (_, i) => ({
      key: `ingredient-artwork/${venue}/${i.toString(16).padStart(64, '0')}.png`,
      uploaded: oldDate,
    }));
    const page2 = Array.from({ length: 500 }, (_, i) => ({
      key: `ingredient-artwork/${venue}/${(i + 1000).toString(16).padStart(64, '0')}.png`,
      uploaded: oldDate,
    }));

    const storage = {
      list: vi.fn(async ({ cursor }: { prefix: string; cursor?: string | undefined }) =>
        cursor === 'p2'
          ? { objects: page2, truncated: false }
          : { objects: page1, truncated: true, cursor: 'p2' },
      ),
      delete: vi.fn(),
    };
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('SELECT DISTINCT sha256')) {
          const hashes = (params?.[1] as string[]) ?? [];
          return { rows: hashes.map((sha256) => ({ sha256 })) };
        }
        return { rows: [] };
      }),
    };

    const bounded = await cleanupOrphanedIngredientArtwork({
      storage,
      client: client as never,
      gracePeriodMs: 3_600_000,
      maxScanned: 1200,
      maxPages: 5,
      nowMs,
    });
    expect(bounded.scanned).toBe(1200);
    expect(bounded.pagesScanned).toBe(2);
    expect(bounded.protectedApproved).toBe(1200);
    expect(bounded.deleted).toBe(0);
    expect(bounded.truncated).toBe(true);
    // Only 2 batched SELECT DISTINCT queries across 1200 approved objects.
    const selectCalls = client.query.mock.calls.filter(([s]) =>
      String(s).includes('SELECT DISTINCT sha256'),
    );
    expect(selectCalls).toHaveLength(2);

    // Dry-run mode reports deleted without calling storage.delete.
    const dryClient = {
      query: vi.fn(async () => ({ rows: [] })),
    };
    const dry = await cleanupOrphanedIngredientArtwork({
      storage: {
        list: vi.fn(async () => ({
          objects: [{ key: `ingredient-artwork/${venue}/${shaA}.png`, uploaded: oldDate }],
          truncated: false,
        })),
        delete: storage.delete,
      },
      client: dryClient as never,
      gracePeriodMs: 3_600_000,
      dryRun: true,
      nowMs,
    });
    expect(dry.deleted).toBe(1);
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('handles DB failures, R2 list failures, and partial delete failures safely', async () => {
    const nowMs = Date.UTC(2026, 10, 14, 12, 0, 0);
    const oldDate = new Date(nowMs - 2 * 3_600_000);
    const deletedKeys: string[] = [];

    const storage = {
      list: vi.fn(async () => ({
        objects: [
          { key: `ingredient-artwork/${venue}/${shaA}.png`, uploaded: oldDate },
          { key: `ingredient-artwork/${venue}/${shaB}.png`, uploaded: oldDate },
        ],
        truncated: false,
      })),
      delete: vi.fn(async (key: string) => {
        if (key.includes(shaA)) throw new Error('R2 transient error');
        deletedKeys.push(key);
      }),
    };
    const client = {
      query: vi.fn(async () => ({ rows: [] })),
    };

    const partial = await cleanupOrphanedIngredientArtwork({
      storage,
      client: client as never,
      gracePeriodMs: 3_600_000,
      nowMs,
    });
    expect(deletedKeys).toEqual([`ingredient-artwork/${venue}/${shaB}.png`]);
    expect(partial.errors).toBe(1);
    expect(partial.deleted).toBe(1);

    // DB lookup failure increments errors and skips deletes.
    const failingDb = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('SELECT DISTINCT sha256')) throw new Error('DB down');
        return { rows: [] };
      }),
    };
    const dbErr = await cleanupOrphanedIngredientArtwork({
      storage: { ...storage, delete: vi.fn() },
      client: failingDb as never,
      gracePeriodMs: 3_600_000,
      nowMs,
    });
    expect(dbErr.errors).toBe(2);
    expect(dbErr.deleted).toBe(0);

    // R2 list failure propagates cleanly.
    await expect(
      cleanupOrphanedIngredientArtwork({
        storage: {
          list: vi.fn(async () => {
            throw new Error('R2 list down');
          }),
          delete: vi.fn(),
        },
        client: client as never,
      }),
    ).rejects.toThrow('R2 list down');
  });

  it('closes Phase C/D races via head timestamp refresh, DB recheck, head errors, and multi-venue batching', async () => {
    const nowMs = Date.UTC(2026, 10, 14, 12, 0, 0);
    const oldDate = new Date(nowMs - 2 * 3_600_000);
    const refreshedDate = new Date(nowMs - 1_000);
    const venue2 = '33333333-3333-4333-8333-333333333333';
    const deletedKeys: string[] = [];

    let dbCall = 0;
    const tenantConfigs: string[] = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes("set_config('app.tenant_id'")) {
          tenantConfigs.push(String(params?.[0]));
        }
        if (sql.includes('SELECT DISTINCT sha256')) {
          dbCall++;
          const hashes = (params?.[1] as string[]) ?? [];
          // Batched check returns none approved; per-key recheck for shaB simulates concurrent Phase C commit!
          if (dbCall >= 2 && hashes.length === 1 && hashes[0] === shaB) {
            return { rows: [{ sha256: shaB }] };
          }
          return { rows: [] };
        }
        return { rows: [] };
      }),
    };

    const storage = {
      list: vi.fn(async () => ({
        objects: [
          { key: `ingredient-artwork/${venue}/${shaA}.png`, uploaded: oldDate }, // head sees refreshed timestamp
          { key: `ingredient-artwork/${venue}/${shaB}.png`, uploaded: oldDate }, // DB recheck sees concurrent approval
          { key: `ingredient-artwork/${venue}/${shaC}.png`, uploaded: oldDate }, // head returns null (concurrent worker deleted)
          { key: `ingredient-artwork/${venue2}/${shaA}.png`, uploaded: oldDate }, // head throws
        ],
        truncated: false,
      })),
      head: vi.fn(async (key: string) => {
        if (key.includes(venue2)) throw new Error('head failed');
        if (key.includes(shaA)) return { uploaded: refreshedDate };
        if (key.includes(shaC)) return null;
        return { uploaded: oldDate };
      }),
      delete: vi.fn(async (key: string) => {
        deletedKeys.push(key);
      }),
    };

    const res = await cleanupOrphanedIngredientArtwork({
      storage,
      client: client as never,
      gracePeriodMs: 3_600_000,
      nowMs,
    });

    expect(deletedKeys).toEqual([]);
    expect(res.protectedInFlight).toBe(1);
    expect(res.protectedApproved).toBe(1);
    expect(res.errors).toBe(1);
    expect(tenantConfigs).toContain(venue);
    expect(tenantConfigs).toContain(venue2);
  });

  it('enforces maxPages across empty truncated pages', async () => {
    const storage = {
      list: vi.fn(async ({ cursor }: { prefix: string; cursor?: string | undefined }) => ({
        objects: [],
        truncated: true,
        cursor: cursor ? `${cursor}x` : 'p1',
      })),
      delete: vi.fn(),
    };
    const client = { query: vi.fn(async () => ({ rows: [] })) };

    const res = await cleanupOrphanedIngredientArtwork({
      storage,
      client: client as never,
      maxPages: 3,
    });
    expect(res.pagesScanned).toBe(3);
    expect(res.truncated).toBe(true);
    expect(storage.list).toHaveBeenCalledTimes(3);
  });
});

describe('scheduled handler isolation and strict env parsing', () => {
  it('strictly parses non-negative integer env vars and rejects malformed values', () => {
    expect(parseNonNegativeIntEnv(undefined, 'err')).toBeUndefined();
    expect(parseNonNegativeIntEnv('0', 'err')).toBe(0);
    expect(parseNonNegativeIntEnv('3600000', 'err')).toBe(3600000);
    for (const bad of ['', 'abc', '1000abc', '-1', '1.5', ' 10 ']) {
      expect(() => parseNonNegativeIntEnv(bad, 'invalid_artwork_grace_period')).toThrow(
        'invalid_artwork_grace_period',
      );
    }
  });

  it('runs artwork cleanup independently of order-import bucket presence and failures', async () => {
    const fakeClient = {
      connect: vi.fn(async () => {}),
      query: vi.fn(async () => ({ rows: [] })),
      end: vi.fn(async () => {}),
    };
    const makeBucket = (failList = false) => ({
      put: vi.fn(async () => {}),
      list: vi.fn(async () => {
        if (failList) throw new Error('list failed');
        return { objects: [], truncated: false };
      }),
      delete: vi.fn(async () => {}),
    });

    // 1. Dedicated artwork bucket only (no order-import bucket).
    const artOnly = makeBucket();
    await handleScheduled(
      {},
      {
        APP_ENV: 'local',
        LOCAL_DATABASE_URL: 'postgres://local',
        INGREDIENT_ARTWORK_ENABLED: 'true',
        INGREDIENT_ARTWORK_BUCKET: artOnly,
      },
      () => fakeClient as never,
    );
    expect(artOnly.list).toHaveBeenCalledWith({ prefix: 'ingredient-artwork/', cursor: undefined });

    // 2. Order-import bucket only (artwork disabled).
    const orderOnly = makeBucket();
    await handleScheduled(
      {},
      {
        APP_ENV: 'local',
        LOCAL_DATABASE_URL: 'postgres://local',
        ORDER_IMPORT_BUCKET: orderOnly as never,
      },
      () => fakeClient as never,
    );
    expect(orderOnly.list).toHaveBeenCalledWith(
      expect.objectContaining({ prefix: 'order-imports/' }),
    );

    // 3. Order-import cleanup throws -> artwork cleanup still runs!
    const failingOrder = makeBucket(true);
    const workingArt = makeBucket(false);
    await handleScheduled(
      {},
      {
        APP_ENV: 'local',
        LOCAL_DATABASE_URL: 'postgres://local',
        INGREDIENT_ARTWORK_ENABLED: 'true',
        ORDER_IMPORT_BUCKET: failingOrder as never,
        INGREDIENT_ARTWORK_BUCKET: workingArt,
      },
      () => fakeClient as never,
    );
    expect(failingOrder.list).toHaveBeenCalled();
    expect(workingArt.list).toHaveBeenCalled();

    // 4. Artwork cleanup throws -> order-import cleanup still runs!
    const workingOrder = makeBucket(false);
    const failingArt = makeBucket(true);
    await handleScheduled(
      {},
      {
        APP_ENV: 'local',
        LOCAL_DATABASE_URL: 'postgres://local',
        INGREDIENT_ARTWORK_ENABLED: 'true',
        ORDER_IMPORT_BUCKET: workingOrder as never,
        INGREDIENT_ARTWORK_BUCKET: failingArt,
      },
      () => fakeClient as never,
    );
    expect(workingOrder.list).toHaveBeenCalled();
    expect(failingArt.list).toHaveBeenCalled();

    // 5. Neither bucket configured -> returns early without connecting DB.
    const connectSpy = vi.fn(async () => {});
    await handleScheduled(
      {},
      { APP_ENV: 'local', LOCAL_DATABASE_URL: 'postgres://local' },
      () =>
        ({
          ...fakeClient,
          connect: connectSpy,
        }) as never,
    );
    expect(connectSpy).not.toHaveBeenCalled();

    // 6. Artwork feature flag disabled -> artwork cleanup does NOT run even with bucket configured.
    const disabledArtBucket = makeBucket();
    await handleScheduled(
      {},
      {
        APP_ENV: 'local',
        LOCAL_DATABASE_URL: 'postgres://local',
        INGREDIENT_ARTWORK_ENABLED: 'false',
        INGREDIENT_ARTWORK_BUCKET: disabledArtBucket,
      },
      () => fakeClient as never,
    );
    expect(disabledArtBucket.list).not.toHaveBeenCalled();

    // 7. Staging bucket only + staging throws while artwork succeeds.
    const stagingFailBucket = {
      ...makeBucket(true),
      get: vi.fn(async () => null),
    };
    const artOkBucket = makeBucket(false);
    await handleScheduled(
      {},
      {
        APP_ENV: 'local',
        LOCAL_DATABASE_URL: 'postgres://local',
        INGREDIENT_ARTWORK_ENABLED: 'true',
        INGESTION_REPORTS_BUCKET: stagingFailBucket as never,
        INGREDIENT_ARTWORK_BUCKET: artOkBucket,
        MENU_STAGING_RETENTION_DAYS: '7',
      },
      () => fakeClient as never,
    );
    expect(stagingFailBucket.list).toHaveBeenCalled();
    expect(artOkBucket.list).toHaveBeenCalled();
  });
});
