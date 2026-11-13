import { describe, expect, it, vi } from 'vitest';
import { cleanupStagedMenuPhotos } from './owner-menu-retention';

describe('cleanupStagedMenuPhotos', () => {
  it('exits early without deleting anything when retention is unconfigured', async () => {
    const storage = {
      list: vi.fn(),
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };
    const client = { query: vi.fn() };

    const result = await cleanupStagedMenuPhotos({
      storage: storage as any,
      client: client as any,
      retentionConfig: {},
    });

    expect(result.scanned).toBe(0);
    expect(result.promotedDeleted).toBe(0);
    expect(storage.list).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('strictly ignores keys outside menu-staging/ and never touches menu-assets/', async () => {
    const storage = {
      list: vi.fn().mockResolvedValue({
        objects: [
          { key: 'menu-assets/venue1/photo1/hash1' },
          { key: 'menu-ingestion/sources/venue1/job1/source' },
          { key: 'order-imports/file.csv' },
        ],
      }),
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };
    const client = { query: vi.fn() };

    const result = await cleanupStagedMenuPhotos({
      storage: storage as any,
      client: client as any,
      retentionConfig: { promotedRetentionDays: 1 },
    });

    expect(result.scanned).toBe(0);
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('protects active unverified photos on pending drafts from deletion', async () => {
    const storage = {
      list: vi.fn().mockResolvedValue({
        objects: [{ key: 'menu-staging/venue-1/draft-1/hash-1' }],
      }),
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };
    const client = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            id: 'photo-1',
            verification_status: 'not_verified',
            storage_key: 'menu-staging/venue-1/draft-1/hash-1',
            promoted_storage_key: null,
            updated_at: new Date(Date.now() - 100 * 86_400_000),
            draft_review_status: 'pending',
          },
        ],
      }),
    };

    const result = await cleanupStagedMenuPhotos({
      storage: storage as any,
      client: client as any,
      retentionConfig: { promotedRetentionDays: 0, rejectedRetentionDays: 1, orphanGraceDays: 1 },
    });

    expect(result.scanned).toBe(1);
    expect(result.protectedPending).toBe(1);
    expect(result.promotedDeleted).toBe(0);
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('deletes promoted photos whose reference is confirmed in PostgreSQL', async () => {
    const storage = {
      list: vi.fn().mockResolvedValue({
        objects: [{ key: 'menu-staging/venue-1/draft-1/hash-1' }],
      }),
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn().mockResolvedValue({}),
    };
    const client = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            id: 'photo-1',
            verification_status: 'verified',
            storage_key: 'menu-assets/venue-1/photo-1/hash-1',
            promoted_storage_key: 'menu-assets/venue-1/photo-1/hash-1',
            updated_at: new Date(Date.now() - 2 * 86_400_000),
            draft_review_status: 'accepted',
          },
        ],
      }),
    };

    const result = await cleanupStagedMenuPhotos({
      storage: storage as any,
      client: client as any,
      retentionConfig: { promotedRetentionDays: 0 },
    });

    expect(result.scanned).toBe(1);
    expect(result.promotedDeleted).toBe(1);
    expect(storage.delete).toHaveBeenCalledWith('menu-staging/venue-1/draft-1/hash-1');
  });

  it('respects dryRun mode and logs without deleting', async () => {
    const storage = {
      list: vi.fn().mockResolvedValue({
        objects: [{ key: 'menu-staging/venue-1/draft-1/hash-1' }],
      }),
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };
    const client = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            id: 'photo-1',
            verification_status: 'verified',
            storage_key: 'menu-assets/venue-1/photo-1/hash-1',
            promoted_storage_key: 'menu-assets/venue-1/photo-1/hash-1',
            updated_at: new Date(Date.now() - 2 * 86_400_000),
            draft_review_status: 'accepted',
          },
        ],
      }),
    };

    const result = await cleanupStagedMenuPhotos({
      storage: storage as any,
      client: client as any,
      retentionConfig: { promotedRetentionDays: 0 },
      dryRun: true,
    });

    expect(result.scanned).toBe(1);
    expect(result.promotedDeleted).toBe(1);
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('protects rejected photos from deletion if draft is in active review (pending)', async () => {
    const storage = {
      list: vi.fn().mockResolvedValue({
        objects: [{ key: 'menu-staging/venue-1/draft-1/hash-1' }],
      }),
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };
    const client = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            id: 'photo-1',
            verification_status: 'rejected',
            storage_key: 'menu-staging/venue-1/draft-1/hash-1',
            promoted_storage_key: null,
            updated_at: new Date(Date.now() - 100 * 86_400_000), // > 1 day ago
            draft_review_status: 'pending', // active review!
          },
        ],
      }),
    };

    const result = await cleanupStagedMenuPhotos({
      storage: storage as any,
      client: client as any,
      retentionConfig: { rejectedRetentionDays: 1 },
    });

    expect(result.scanned).toBe(1);
    expect(result.protectedPending).toBe(1);
    expect(result.rejectedDeleted).toBe(0);
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('protects in-flight orphan uploads when attached to an active pending draft', async () => {
    const storage = {
      list: vi.fn().mockResolvedValue({
        objects: [
          {
            key: 'menu-staging/venue-1/draft-1/hash-1',
            uploaded: new Date(Date.now() - 100 * 86_400_000),
          },
        ],
      }),
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] }) // no dish_draft_photo record
        .mockResolvedValueOnce({ rows: [{ id: 'draft-1' }] }), // but active dish_drafts review_status = 'pending'!
    };

    const result = await cleanupStagedMenuPhotos({
      storage: storage as any,
      client: client as any,
      retentionConfig: { orphanGraceDays: 1 },
    });

    expect(result.scanned).toBe(1);
    expect(result.protectedPending).toBe(1);
    expect(result.orphansDeleted).toBe(0);
    expect(storage.delete).not.toHaveBeenCalled();
  });
});
