import { createHash } from 'node:crypto';
import type { Client } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { cleanupStagedMenuPhotos } from './owner-menu-retention';

const venue = '00000000-0000-4000-8000-000000000001';
const draft = '00000000-0000-4000-8000-000000000002';
const photoId = '00000000-0000-4000-8000-000000000003';
const bytes = new Uint8Array([1, 2, 3]).buffer;
const hash = createHash('sha256').update(Buffer.from(bytes)).digest('hex');
const key = `menu-staging/${venue}/${draft}/${hash}`;
const destination = `menu-assets/${venue}/${photoId}/${hash}`;
const portionPrefix = `private-portions/${venue}/${draft}/${photoId}/${hash}`;
const portionKeys = ['approval.json', 'record.json', 'background.svg', 'dish.webp'].map(
  (name) => `${portionPrefix}/${name}`,
);
function fixture(photo?: Record<string, unknown>, pending = false) {
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes('FROM app_private.dish_drafts')
      ? pending
        ? [{ review_status: 'pending' }]
        : []
      : sql.includes('FROM app_private.dish_draft_photo') && photo
        ? [photo]
        : [],
  }));
  const storage = {
    list: vi.fn(async (_options?: unknown) => ({ objects: [{ key, uploaded: new Date(0) }] })),
    get: vi.fn(async (_key: string) => ({ arrayBuffer: async () => bytes })),
    put: vi.fn(async () => {}),
    delete: vi.fn(async (_key: string) => {}),
  };
  const client = { query } as unknown as Client;
  return { client, query, storage };
}
const promoted = {
  id: photoId,
  verification_status: 'verified',
  storage_key: destination,
  promoted_storage_key: destination,
  updated_at: new Date(0),
  size_bytes: 3,
};
describe('staged photo retention', () => {
  it('does nothing until configured and rejects invalid retention values', async () => {
    const f = fixture();
    expect((await cleanupStagedMenuPhotos(f)).scanned).toBe(0);
    expect(f.storage.list).not.toHaveBeenCalled();
    for (const value of [NaN, Infinity, -1])
      await expect(
        cleanupStagedMenuPhotos({ ...f, retentionConfig: { orphanGraceDays: value } }),
      ).rejects.toThrow('invalid_menu_retention');
  });
  it('protects pending and unverified originals under tenant-scoped row locks', async () => {
    const f = fixture({ verification_status: 'not_verified' }, true);
    const result = await cleanupStagedMenuPhotos({ ...f, retentionConfig: { orphanGraceDays: 1 } });
    expect(result.protectedPending).toBe(1);
    expect(f.storage.delete).not.toHaveBeenCalled();
    expect(f.query.mock.calls.map((call) => call[0]).join(' ')).toContain(
      "set_config('app.tenant_id'",
    );
    expect(f.query.mock.calls.filter((call) => call[0].includes('FOR UPDATE'))).toHaveLength(2);
    expect(f.query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
  });
  it('checks promoted bytes before removing only the staged original', async () => {
    const f = fixture(promoted);
    expect(
      (await cleanupStagedMenuPhotos({ ...f, retentionConfig: { promotedRetentionDays: 0 } }))
        .promotedDeleted,
    ).toBe(1);
    expect(f.storage.delete).toHaveBeenCalledExactlyOnceWith(key);
    const broken = fixture(promoted);
    broken.storage.get.mockResolvedValue({
      arrayBuffer: async () => new Uint8Array([8, 9, 0]).buffer,
    });
    expect(
      (await cleanupStagedMenuPhotos({ ...broken, retentionConfig: { promotedRetentionDays: 0 } }))
        .retained,
    ).toBe(1);
    expect(broken.storage.delete).not.toHaveBeenCalled();
  });
  it('leaves promoted cleanup disabled when only orphan retention is configured', async () => {
    const f = fixture(promoted);
    expect(
      (await cleanupStagedMenuPhotos({ ...f, retentionConfig: { orphanGraceDays: 1 } })).retained,
    ).toBe(1);
    expect(f.storage.delete).not.toHaveBeenCalled();
  });
  it('retains malformed keys, non-menu assets and failed database lookups', async () => {
    const f = fixture();
    f.storage.list.mockResolvedValue({
      objects: [
        { key: 'menu-assets/anything', uploaded: new Date(0) },
        { key: key + '/extra', uploaded: new Date(0) },
      ],
    });
    expect(
      (await cleanupStagedMenuPhotos({ ...f, retentionConfig: { orphanGraceDays: 1 } })).retained,
    ).toBe(1);
    expect(f.query).not.toHaveBeenCalled();
    const failed = fixture();
    failed.query.mockRejectedValueOnce(new Error('database unavailable'));
    expect(
      (await cleanupStagedMenuPhotos({ ...failed, retentionConfig: { orphanGraceDays: 1 } }))
        .retained,
    ).toBe(1);
    expect(failed.storage.delete).not.toHaveBeenCalled();
  });
  it('supports dry runs, rejected retention and expired orphans without deleting pending work', async () => {
    const f = fixture({ verification_status: 'rejected', updated_at: new Date(0) });
    expect(
      (
        await cleanupStagedMenuPhotos({
          ...f,
          dryRun: true,
          retentionConfig: { rejectedRetentionDays: 1 },
        })
      ).rejectedDeleted,
    ).toBe(1);
    expect(f.storage.delete).not.toHaveBeenCalled();
    const orphan = fixture();
    expect(
      (await cleanupStagedMenuPhotos({ ...orphan, retentionConfig: { orphanGraceDays: 1 } }))
        .orphansDeleted,
    ).toBe(1);
    expect(orphan.storage.delete).toHaveBeenCalledExactlyOnceWith(key);
  });
  it('cleans only expired rejected portion artifacts, even if the draft is pending', async () => {
    const f = fixture({ verification_status: 'rejected', updated_at: new Date(0) }, true);
    f.storage.list.mockResolvedValue({
      objects: [
        ...portionKeys.map((key) => ({ key, uploaded: new Date(0) })),
        { key: `${portionPrefix}/unexpected`, uploaded: new Date(0) },
        { key, uploaded: new Date(0) },
      ],
    });
    const options = { ...f, retentionConfig: { rejectedRetentionDays: 1 } };
    expect((await cleanupStagedMenuPhotos({ ...options, dryRun: true })).rejectedDeleted).toBe(4);
    expect(f.storage.delete).not.toHaveBeenCalled();
    expect((await cleanupStagedMenuPhotos(options)).rejectedDeleted).toBe(4);
    expect(f.storage.delete.mock.calls.flat()).toEqual(portionKeys);
  });
  it('protects active portion files and retains fresh orphans until the configured grace expires', async () => {
    const stale = `${portionPrefix}/approval.json`;
    const fresh = `${portionPrefix.replace(photoId, '00000000-0000-4000-8000-000000000004')}/record.json`;
    for (const photo of [promoted, { verification_status: 'not_verified' }, undefined]) {
      const f = fixture(photo, true);
      f.storage.list.mockResolvedValue({
        objects: [
          { key: stale, uploaded: new Date(0) },
          { key: fresh, uploaded: new Date() },
        ],
      });
      await cleanupStagedMenuPhotos({
        ...f,
        retentionConfig: { promotedRetentionDays: 0, orphanGraceDays: 1 },
      });
      expect(f.storage.delete.mock.calls.flat()).toEqual(photo ? [] : [stale]);
      expect(f.storage.get).not.toHaveBeenCalled();
    }
  });
  it('retains all layers if the manifest cannot be removed', async () => {
    const f = fixture({ verification_status: 'rejected', updated_at: new Date(0) });
    f.storage.list.mockResolvedValue({
      objects: portionKeys.map((key) => ({ key, uploaded: new Date(0) })),
    });
    f.storage.delete.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('R2 failed'));
    const result = await cleanupStagedMenuPhotos({
      ...f,
      retentionConfig: { rejectedRetentionDays: 1 },
    });
    expect(f.storage.delete.mock.calls.flat()).toEqual(portionKeys.slice(0, 2));
    expect(result).toMatchObject({ scanned: 4, rejectedDeleted: 1, retained: 3 });
  });
  it('reads successive R2 pages and refuses repeated cursors', async () => {
    const f = fixture();
    const list = vi
      .fn()
      .mockResolvedValue({ objects: [], truncated: false })
      .mockResolvedValueOnce({ objects: [], truncated: true, cursor: 'next' })
      .mockResolvedValueOnce({ objects: [{ key, uploaded: new Date(0) }], truncated: false });
    expect(
      (
        await cleanupStagedMenuPhotos({
          ...f,
          storage: { ...f.storage, list },
          retentionConfig: { orphanGraceDays: 1 },
        })
      ).orphansDeleted,
    ).toBe(1);
    expect(list.mock.calls).toEqual([
      [{ prefix: 'menu-staging/', cursor: undefined }],
      [{ prefix: 'menu-staging/', cursor: 'next' }],
      [{ prefix: 'private-portions/', cursor: undefined }],
    ]);
    list.mockResolvedValue({ objects: [], truncated: true, cursor: 'next' });
    await expect(
      cleanupStagedMenuPhotos({
        ...f,
        storage: { ...f.storage, list },
        retentionConfig: { orphanGraceDays: 1 },
      }),
    ).rejects.toThrow('invalid_menu_retention_cursor');
  });
});
