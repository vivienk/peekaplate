import type { Client } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleScheduled } from './index';
import { cleanupOrphanedIngredientArtwork } from './ingredient-artwork-retention';
import { cleanupStagedMenuPhotos } from './owner-menu-retention';

vi.mock('./owner-menu-retention', () => ({ cleanupStagedMenuPhotos: vi.fn() }));
vi.mock('./ingredient-artwork-retention', () => ({ cleanupOrphanedIngredientArtwork: vi.fn() }));

describe('focused release staged-photo retention scheduling', () => {
  beforeEach(() => vi.resetAllMocks());
  const client = () => ({ connect: vi.fn(async () => {}), end: vi.fn(async () => {}) });
  const storage = () => ({ put: vi.fn(), get: vi.fn(), list: vi.fn(), delete: vi.fn() });

  it('runs configured private-photo retention when ingredient artwork is disabled', async () => {
    const database = client();
    await handleScheduled(
      {},
      {
        APP_ENV: 'local',
        LOCAL_DATABASE_URL: 'postgres://synthetic.invalid/test',
        MENU_STAGING_REJECTED_RETENTION_DAYS: '7',
        INGESTION_REPORTS_BUCKET: storage(),
      },
      () => database as unknown as Client,
    );
    expect(cleanupStagedMenuPhotos).toHaveBeenCalledWith(
      expect.objectContaining({
        retentionConfig: {
          promotedRetentionDays: undefined,
          rejectedRetentionDays: 7,
          orphanGraceDays: 0,
        },
        dryRun: false,
      }),
    );
    expect(cleanupOrphanedIngredientArtwork).not.toHaveBeenCalled();
    expect(database.end).toHaveBeenCalledOnce();
  });

  it('preserves artwork cleanup and connection release when private-photo cleanup fails', async () => {
    const database = client();
    vi.mocked(cleanupStagedMenuPhotos).mockRejectedValueOnce(new Error('synthetic failure'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await handleScheduled(
        {},
        {
          APP_ENV: 'local',
          LOCAL_DATABASE_URL: 'postgres://synthetic.invalid/test',
          INGREDIENT_ARTWORK_ENABLED: 'true',
          MENU_STAGING_REJECTED_RETENTION_DAYS: '7',
          INGESTION_REPORTS_BUCKET: storage(),
        },
        () => database as unknown as Client,
      );
      expect(cleanupStagedMenuPhotos).toHaveBeenCalledOnce();
      expect(cleanupOrphanedIngredientArtwork).toHaveBeenCalledOnce();
      expect(database.end).toHaveBeenCalledOnce();
      expect(error).toHaveBeenCalledWith(JSON.stringify({ event: 'menu_staging_cleanup_error' }));
    } finally {
      error.mockRestore();
    }
  });
});
