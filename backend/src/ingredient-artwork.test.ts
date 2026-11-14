import { createHash } from 'node:crypto';
import { type ArtworkCommand, ArtworkCommandSchema } from '@peekaplate/contracts';
import { describe, expect, it, vi } from 'vitest';
import { readArtwork, replayArtwork, reviewArtwork, reviewedPng } from './ingredient-artwork';

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
      expect(db.query.mock.calls.some((c) => c[0] === 'COMMIT')).toBe(false);
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
});
