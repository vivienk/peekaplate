import { createHash } from 'node:crypto';
import {
  type PlateCalibration,
  PublicMenuContentBundleSchema,
  PublicPortionSchema,
} from '@peekaplate/contracts';
import type { Client } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { previewKey } from './owner-portion-preview';
import { assetUrl, readPreparedPreviewAsset } from './owner-prepare';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const venue = id(1),
  dish = id(2),
  revision = id(3),
  draft = id(4),
  photo = id(5),
  actor = id(6);
const origin = 'https://api.example.test';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const source = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
    'base64',
  ),
);

function snapshot(servingCount?: number, plateOverrides: Partial<PlateCalibration> = {}) {
  const sourceHash = sha(source);
  const storageKey = `menu-assets/${venue}/${photo}/${sourceHash}`;
  const key = previewKey(venue, draft, photo, sourceHash);
  const layers = [
    { name: 'background.svg', bytes: new TextEncoder().encode('<svg/>'), depth: 0 },
    {
      name: 'dish.webp',
      bytes: new TextEncoder().encode('synthetic reviewed foreground'),
      depth: 1,
    },
  ];
  const privatePortion = PublicPortionSchema.parse({
    schema_version: 1,
    dish_id: draft,
    dish_revision_id: photo,
    width: 64,
    height: 64,
    layers: layers.map((layer) => ({
      url: `https://portion-ingestion.invalid/${layer.name}`,
      sha256: sha(layer.bytes),
      size_bytes: layer.bytes.length,
      depth: layer.depth,
    })),
  });
  const plate: PlateCalibration = {
    shape: 'round',
    width_mm: 240,
    depth_mm: 240,
    source_sha256: sourceHash,
    source_width_px: 1,
    source_height_px: 1,
    boundary: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
    confirmed: true,
    ...plateOverrides,
  };
  const foreground = privatePortion.layers[1]!;
  const portion = PublicPortionSchema.parse({
    ...privatePortion,
    dish_id: dish,
    dish_revision_id: revision,
    physical_size: {
      plate,
      source: 'owner',
      validation_status: 'pending',
      foreground_sha256: foreground.sha256,
      ...(servingCount === undefined ? {} : { serving_count: servingCount }),
    },
    layers: privatePortion.layers.map((layer) => ({
      ...layer,
      url: assetUrl(origin, venue, photo, layer.sha256),
    })),
  });
  const content = PublicMenuContentBundleSchema.parse({
    schema_version: 1,
    venue_id: venue,
    menu_id: id(7),
    menu_revision_id: id(8),
    restaurant: { name: 'Synthetic cafe', logo: null },
    categories: [
      {
        category_id: id(9),
        name: 'Lunch',
        dishes: [
          {
            dish_id: dish,
            dish_revision_id: revision,
            complete: true,
            name: 'Synthetic dish',
            description: 'Captured portion.',
            price: { amount: '12', currency: 'USD' },
            ingredients: [],
            allergens: null,
            dietary: [],
            images: null,
            portion,
            ...(servingCount === undefined ? {} : { serving_count: servingCount }),
          },
        ],
      },
    ],
  });
  const objects = new Map<string, Uint8Array>([
    [storageKey, source],
    [
      `${key}/record.json`,
      json({
        status: 'needs_review',
        photo_sha256: sourceHash,
        dish_id: draft,
        draft_revision_id: photo,
        portion: privatePortion,
      }),
    ],
    [
      `${key}/approval.json`,
      json({
        schema_version: 1,
        status: 'approved',
        source_sha256: sourceHash,
        portion_sha256: sha(json(privatePortion)),
        approved_by: actor,
        approved_at: '2026-11-17T19:00:00.000Z',
      }),
    ],
    ...layers.map((layer) => [`${key}/${layer.name}`, layer.bytes] as [string, Uint8Array]),
  ]);
  const storage = {
    get: vi.fn(async (path: string) => {
      const bytes = objects.get(path);
      return bytes ? { arrayBuffer: async () => Uint8Array.from(bytes).buffer } : null;
    }),
    put: vi.fn(),
  };
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('FROM app_private.staff_membership'))
      return { rows: [{ permission: 'owner' }] };
    if (sql.includes('FROM app_private.dish_draft_photo'))
      return {
        rows: [
          {
            draft_id: draft,
            source_hash: sourceHash,
            storage_key: storageKey,
            content_type: 'image/png',
          },
        ],
      };
    if (/dish_current|dish_drafts|candidate_review_current/.test(sql))
      throw new Error('Mutable draft state must not authorize a historical asset');
    return { rows: [] };
  });
  const read = () =>
    readPreparedPreviewAsset(
      { query } as unknown as Client,
      storage,
      actor,
      content,
      origin,
      photo,
      foreground.sha256,
    );
  return {
    read,
    objects,
    storage,
    query,
    content,
    sourceHash,
    storageKey,
    key,
    foreground: layers[1]!.bytes,
  };
}

describe('immutable measured portion asset rereads', () => {
  it.each([undefined, 2])(
    'uses the exact snapshot measurement and current visual approval, without mutable draft reads (count %s)',
    async (count) => {
      const fixture = snapshot(count);
      expect((await fixture.read())?.bytes).toEqual(fixture.foreground);
      expect(fixture.storage.put).not.toHaveBeenCalled();
      expect(
        fixture.query.mock.calls.every(
          ([sql]) => !/dish_current|dish_drafts|candidate_review_current/.test(sql),
        ),
      ).toBe(true);
      fixture.objects.delete(`${fixture.key}/approval.json`);
      expect(await fixture.read()).toBeNull();
    },
  );

  it.each([{ source_sha256: 'b'.repeat(64) }, { source_width_px: 2, source_height_px: 2 }])(
    'refuses a snapshot calibration that does not match the actual source bytes: %j',
    async (override) => {
      expect(await snapshot(undefined, override).read()).toBeNull();
    },
  );

  it('fails closed if the approved source bytes become missing or corrupt', async () => {
    const fixture = snapshot();
    fixture.objects.set(fixture.storageKey, new TextEncoder().encode('different photo'));
    expect(await fixture.read()).toBeNull();
    fixture.objects.delete(fixture.storageKey);
    expect(await fixture.read()).toBeNull();
  });
});
