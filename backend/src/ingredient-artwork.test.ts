import { createHash } from 'node:crypto';
import { type ArtworkCommand, ArtworkCommandSchema } from '@peekaplate/contracts';
import { describe, expect, it, vi } from 'vitest';
import { readArtwork, replayArtwork, reviewArtwork, reviewedPng } from './ingredient-artwork';
import { cleanupOrphanedIngredientArtwork } from './ingredient-artwork-retention';

// Valid 32x32 transparent PNG with one visible pixel, used only as a transport fixture.
export const artPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAJElEQVR4nO3MMQEAAAgDoEU0ju01hIcPBCABADiarrkeAEA+LbVgAsefyYE+AAAAAElFTkSuQmCC',
  'base64',
);
export const artworkInput = (): ArtworkCommand => ({
  commandId: crypto.randomUUID(),
  expectedVersion: 0,
  status: 'approved',
  label: 'grilled chicken',
  reason: 'Synthetic reviewed decoration',
  sha256: createHash('sha256').update(artPng).digest('hex'),
  pngBase64: artPng.toString('base64'),
  sourceAssetId: 'a'.repeat(64),
  styleVersion: 'figma-149-2169.v1',
  rightsConfirmed: true,
  recipe: 'Synthetic fixture',
});
const venue = '11111111-1111-4111-8111-111111111111';
const actor = '22222222-2222-4222-8222-222222222222';

function client(
  options: { permission?: string; receipt?: unknown; version?: number; fail?: string } = {},
) {
  const query = vi.fn(async (sql: string) => {
    if (options.fail && sql.includes(options.fail)) throw new Error('Injected transaction failure');
    if (sql.includes('SELECT permission'))
      return { rows: [{ permission: options.permission ?? 'owner' }] };
    if (sql.startsWith('SELECT request_hash'))
      return { rows: options.receipt ? [options.receipt] : [] };
    if (sql.startsWith('SELECT stream_id'))
      return {
        rows: options.version ? [{ version: options.version, stream_id: crypto.randomUUID() }] : [],
      };
    return { rows: [] };
  });
  return { query };
}
describe('ingredient artwork approval', () => {
  it('accepts the exact reviewed bytes of transparent indexed PNGs', () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgAQMAAABJtOi3AAAABlBMVEUAAAD/eFCXci8oAAAAAXRSTlMAQObYZgAAAA9JREFUeJxjYKA6aKCmYQAnIACBGPqPSwAAAABJRU5ErkJggg==',
      'base64',
    );
    const input = artworkInput();
    if (input.status !== 'approved') throw Error();
    const approved = {
      ...input,
      pngBase64: png.toString('base64'),
      sha256: createHash('sha256').update(png).digest('hex'),
    };
    expect(Buffer.from(reviewedPng(approved))).toEqual(png);
    const truncated = png.subarray(0, -1);
    expect(() =>
      reviewedPng({
        ...approved,
        pngBase64: truncated.toString('base64'),
        sha256: createHash('sha256').update(truncated).digest('hex'),
      }),
    ).toThrow();
  });
  it('commits immutable bytes, event, projection, receipt and outbox together', async () => {
    const db = client();
    const put = vi.fn();
    const input = artworkInput();
    const result = await reviewArtwork(db as never, actor, venue, input, { put });
    expect(result).toMatchObject({ label: 'grilled chicken', status: 'approved', version: 1 });
    expect(put).toHaveBeenCalledOnce();
    const sql = db.query.mock.calls.map((c) => c[0]);
    for (const table of ['es_event', 'ingredient_artwork_current', 'es_command', 'outbox'])
      expect(sql.some((q) => q.startsWith(`INSERT INTO app_private.${table}`))).toBe(true);
    expect(sql.at(-1)).toBe('COMMIT');
    expect(sql.join(' ')).not.toContain('menu_publication');
  });
  it('reauthorizes, enforces expected versions and fails before writing bytes', async () => {
    for (const [options, code] of [
      [{ permission: 'viewer' }, 'forbidden'],
      [{ version: 2 }, 'version_conflict'],
    ] as const) {
      const db = client(options);
      const put = vi.fn();
      await expect(
        reviewArtwork(db as never, actor, venue, artworkInput(), { put }),
      ).rejects.toMatchObject({ code });
      expect(put).not.toHaveBeenCalled();
      expect(db.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    }
  });
  it('rolls back when event or projection persistence fails', async () => {
    for (const fail of [
      'INSERT INTO app_private.es_event',
      'INSERT INTO app_private.ingredient_artwork_current',
    ]) {
      const db = client({ fail });
      await expect(
        reviewArtwork(db as never, actor, venue, artworkInput(), { put: vi.fn() }),
      ).rejects.toThrow();
      expect(db.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
      const writeBeginIndex = db.query.mock.calls.map((c) => c[0]).lastIndexOf('BEGIN');
      expect(writeBeginIndex).toBeGreaterThan(-1);
      expect(db.query.mock.calls.slice(writeBeginIndex).some((c) => c[0] === 'COMMIT')).toBe(false);
    }
  });
  it('rejects mismatched bytes and unknown approval fields', () => {
    const input = artworkInput();
    if (input.status !== 'approved') throw Error();
    expect(() => reviewedPng({ ...input, sha256: 'b'.repeat(64) })).toThrow();
    expect(ArtworkCommandSchema.safeParse({ ...input, publishable: true }).success).toBe(false);
  });
  it('replays approval and revocation without effects and rejects gaps', () => {
    const event = {
      tenant_id: venue,
      stream_id: actor,
      version: 1,
      schema_version: 1,
      event_type: 'ingredient.artwork.reviewed',
      payload: { label: 'coconut', version: 1, status: 'approved', sha256: 'a'.repeat(64) },
    };
    const revoked = {
      ...event,
      version: 2,
      payload: { label: 'coconut', version: 2, status: 'revoked', sha256: null },
    };
    expect(replayArtwork([event, revoked])).toEqual(revoked.payload);
    expect(() => replayArtwork([revoked])).toThrow();
    expect(() => replayArtwork([event, { ...revoked, tenant_id: actor }])).toThrow();
  });
  it('scopes public reads to the requested venue transaction', async () => {
    const db = client();
    await readArtwork(db as never, venue, ['coconut']);
    expect(db.query).toHaveBeenCalledWith("SELECT set_config('app.tenant_id', $1, true)", [venue]);
    expect(db.query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
  });
  it('performs R2 upload outside any open PostgreSQL transaction', async () => {
    let inTx = false;
    let putInTx: boolean | null = null;
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'BEGIN' || sql === 'BEGIN READ ONLY') inTx = true;
        if (sql === 'COMMIT' || sql === 'ROLLBACK') inTx = false;
        if (sql.includes('SELECT permission')) return { rows: [{ permission: 'owner' }] };
        if (sql.startsWith('SELECT request_hash')) return { rows: [] };
        if (sql.startsWith('SELECT stream_id')) return { rows: [] };
        return { rows: [] };
      }),
    };
    const put = vi.fn(async () => {
      putInTx = inTx;
    });
    await reviewArtwork(db as never, actor, venue, artworkInput(), { put });
    expect(put).toHaveBeenCalledOnce();
    expect(putInTx).toBe(false);
    expect(inTx).toBe(false);
  });
  it('revalidates authorization and expectedVersion in Phase C after R2 upload', async () => {
    // 1. Authorization revoked between Phase A preflight and Phase C commit.
    let authCalls = 0;
    const revokedAuthDb = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('SELECT permission')) {
          authCalls++;
          return { rows: [{ permission: authCalls === 1 ? 'owner' : 'viewer' }] };
        }
        if (sql.startsWith('SELECT request_hash')) return { rows: [] };
        if (sql.startsWith('SELECT stream_id')) return { rows: [] };
        return { rows: [] };
      }),
    };
    await expect(
      reviewArtwork(revokedAuthDb as never, actor, venue, artworkInput(), { put: vi.fn() }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(revokedAuthDb.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');

    // 2. Concurrent review advances version between Phase A preflight and Phase C commit.
    let versionCalls = 0;
    const staleVersionDb = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('SELECT permission')) return { rows: [{ permission: 'owner' }] };
        if (sql.startsWith('SELECT request_hash')) return { rows: [] };
        if (sql.startsWith('SELECT stream_id')) {
          versionCalls++;
          return {
            rows: versionCalls === 1 ? [] : [{ version: 1, stream_id: crypto.randomUUID() }],
          };
        }
        return { rows: [] };
      }),
    };
    await expect(
      reviewArtwork(staleVersionDb as never, actor, venue, artworkInput(), { put: vi.fn() }),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    expect(staleVersionDb.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });
  it('verifies checksum when content-addressed object already exists and rejects mismatch', async () => {
    const input = artworkInput();
    const put = vi.fn(async () => null);
    const matchingGet = vi.fn(async () => ({
      size: artPng.byteLength,
      arrayBuffer: async () => Uint8Array.from(artPng).buffer,
    }));
    const result = await reviewArtwork(client() as never, actor, venue, input, {
      put,
      get: matchingGet,
    });
    expect(result.status).toBe('approved');
    expect(matchingGet).toHaveBeenCalledOnce();

    const tampered = Buffer.from('corrupt-bytes');
    const mismatchGet = vi.fn(async () => ({
      size: tampered.byteLength,
      arrayBuffer: async () => Uint8Array.from(tampered).buffer,
    }));
    const db = client();
    await expect(
      reviewArtwork(db as never, actor, venue, artworkInput(), { put, get: mismatchGet }),
    ).rejects.toMatchObject({ status: 503 });
    expect(
      db.query.mock.calls.some((c) => c[0].startsWith('INSERT INTO app_private.es_event')),
    ).toBe(false);
  });
  it('enforces real PostgreSQL transaction, FOR SHARE, and RLS tenant invariants in Phase A and C', async () => {
    let inTx = false;
    let readOnly = false;
    let tenantId: string | null = null;
    const strictDb = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql === 'BEGIN') {
          if (inTx) throw new Error('Nested BEGIN');
          inTx = true;
          readOnly = false;
          tenantId = null;
          return { rows: [] };
        }
        if (sql === 'BEGIN READ ONLY') {
          if (inTx) throw new Error('Nested BEGIN READ ONLY');
          inTx = true;
          readOnly = true;
          tenantId = null;
          return { rows: [] };
        }
        if (sql === 'COMMIT' || sql === 'ROLLBACK') {
          inTx = false;
          readOnly = false;
          tenantId = null;
          return { rows: [] };
        }
        if (sql.includes('FOR SHARE')) {
          if (readOnly)
            throw new Error('ERROR: cannot execute SELECT FOR SHARE in a read-only transaction');
          return { rows: [{ permission: 'owner' }] };
        }
        if (sql.startsWith("SELECT set_config('app.tenant_id'")) {
          if (inTx) tenantId = String(params?.[0] ?? '');
          return { rows: [] };
        }
        if (
          sql.includes('app_private.es_command') ||
          sql.includes('app_private.ingredient_artwork_current')
        ) {
          if (!inTx || tenantId !== venue) {
            throw new Error('RLS violation: app.tenant_id not active in transaction');
          }
          return { rows: [] };
        }
        return { rows: [] };
      }),
    };
    const result = await reviewArtwork(strictDb as never, actor, venue, artworkInput(), {
      put: vi.fn(),
    });
    expect(result.status).toBe('approved');
    expect(inTx).toBe(false);
  });
  it('protects reused content-addressed object from concurrent cleanup deletion between Phase B and Phase C', async () => {
    const input = artworkInput();
    if (input.status !== 'approved') throw Error();
    const key = `ingredient-artwork/${venue}/${input.sha256}.png`;
    let nowMs = Date.UTC(2026, 10, 14, 12, 0, 0);
    const oldDate = new Date(nowMs - 2 * 3_600_000);
    const r2Objects = new Map<string, { bytes: ArrayBuffer; uploaded: Date }>([
      [key, { bytes: Uint8Array.from(artPng).buffer, uploaded: oldDate }],
    ]);
    let committedApproved = false;
    let cleanupResult: Awaited<ReturnType<typeof cleanupOrphanedIngredientArtwork>> | undefined;

    const storage = {
      put: vi.fn(
        async (
          k: string,
          bytes: ArrayBuffer,
          opts?: { onlyIf?: { etagDoesNotMatch?: string } },
        ) => {
          if (opts?.onlyIf?.etagDoesNotMatch === '*' && r2Objects.has(k)) {
            return null;
          }
          nowMs += 1000;
          r2Objects.set(k, { bytes, uploaded: new Date(nowMs) });
          return { key: k };
        },
      ),
      get: vi.fn(async (k: string) => {
        const obj = r2Objects.get(k);
        return obj ? { size: obj.bytes.byteLength, arrayBuffer: async () => obj.bytes } : null;
      }),
      head: vi.fn(async (k: string) => {
        const obj = r2Objects.get(k);
        return obj ? { uploaded: obj.uploaded } : null;
      }),
      list: vi.fn(async () => ({
        objects: [...r2Objects.entries()].map(([k, v]) => ({ key: k, uploaded: v.uploaded })),
        truncated: false,
      })),
      delete: vi.fn(async (k: string) => {
        r2Objects.delete(k);
      }),
    };

    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('SELECT permission')) return { rows: [{ permission: 'owner' }] };
        if (sql.startsWith('SELECT request_hash')) return { rows: [] };
        if (sql.startsWith('SELECT stream_id')) return { rows: [] };
        if (sql.includes('SELECT DISTINCT sha256')) {
          return { rows: committedApproved ? [{ sha256: input.sha256 }] : [] };
        }
        if (sql.startsWith('INSERT INTO app_private.ingredient_artwork_current')) {
          // Interleave cleanup check right before Phase C commits the approved row.
          cleanupResult = await cleanupOrphanedIngredientArtwork({
            storage,
            client: db as never,
            gracePeriodMs: 3_600_000,
            nowMs,
          });
          committedApproved = true;
        }
        return { rows: [] };
      }),
    };

    const state = await reviewArtwork(db as never, actor, venue, input, storage);
    expect(state.status).toBe('approved');
    expect(cleanupResult?.deleted).toBe(0);
    expect(cleanupResult?.protectedInFlight).toBe(1);
    expect(r2Objects.has(key)).toBe(true);
  });
});
