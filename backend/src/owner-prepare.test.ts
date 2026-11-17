import { createHash } from 'node:crypto';
import { type PlateCalibration, PublicPortionSchema } from '@peekaplate/contracts';
import { describe, expect, it, vi } from 'vitest';
import { prepareApprovedPortion } from './bundle-producer/approved-portions';
import {
  type ApprovedDishSource,
  BundleProducerError,
  type OwnerApprovedPhoto,
  produceMenuBundle,
} from './bundle-producer/produce';
import { MenuBundleRequestSchema } from './bundle-producer/request';
import { assetUrl, ownerMenuId, PREPARED_ASSET_PATH, PREPARED_BUNDLE_PATH } from './owner-prepare';
import { fetchPreparedMenu } from './owner-publication';

const venue = '11111111-1111-4111-8111-111111111111';
const origin = 'https://api.example.test';
const soupId = '22222222-2222-4222-8222-222222222221';
const saladId = '22222222-2222-4222-8222-222222222222';
const soupRevision = '44444444-4444-4444-8444-444444444441';
const saladRevision = '44444444-4444-4444-8444-444444444442';
const photoId = '33333333-3333-4333-8333-333333333331';
const hash = 'a'.repeat(64);

const source = (overrides: Partial<ApprovedDishSource> = {}): ApprovedDishSource => ({
  dishId: soupId,
  dishRevisionId: soupRevision,
  name: 'Fictional Lentil Soup',
  description: 'Slow cooked lentils.',
  priceAmount: '9.50',
  priceCurrency: 'CAD',
  ingredients: ['lentils'],
  reviewState: 'corrected',
  approvedAllergens: ['milk'],
  approvedCategory: 'Soups',
  approvedPhotoId: photoId,
  servingCount: 2,
  ...overrides,
});
const photo = (overrides: Partial<OwnerApprovedPhoto> = {}): OwnerApprovedPhoto => ({
  dishId: soupId,
  dishRevisionId: soupRevision,
  photoId,
  url: assetUrl(origin, venue, photoId, hash),
  sha256: hash,
  width: 800,
  height: 600,
  ...overrides,
});

async function request(dishes: { dish_id: string; portion?: unknown }[]) {
  return MenuBundleRequestSchema.parse({
    schema_version: 1,
    venue_id: venue,
    menu_id: await ownerMenuId(venue),
    restaurant: { name: 'Synthetic Cafe', logo: null },
    bundle_base_url: `${origin}${PREPARED_BUNDLE_PATH}`,
    asset_base_url: `${origin}${PREPARED_ASSET_PATH}`,
    categories: [
      {
        category_id: '55555555-5555-4555-8555-555555555555',
        name: 'Soups',
        dishes: dishes.map((dish) => ({
          allergens: null,
          dietary: [],
          image_alt: 'Photo of the dish',
          t0_asset_id: null,
          ...dish,
        })),
      },
    ],
  });
}

describe('existing producer with owner-approved photos and the text-only fallback (Part A)', () => {
  it('requires owner physical metadata to match the separately approved revision facts', async () => {
    const plate: PlateCalibration = {
      shape: 'round',
      width_mm: 240,
      depth_mm: 240,
      source_sha256: hash,
      source_width_px: 800,
      source_height_px: 800,
      boundary: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
      confirmed: true,
    };
    const draftId = '66666666-6666-4666-8666-666666666666';
    const layers = [
      { name: 'background.svg', depth: 0, bytes: Buffer.from('<svg/>') },
      { name: 'dish.webp', depth: 1, bytes: Buffer.from('synthetic reviewed foreground') },
    ];
    const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    const privatePortion = PublicPortionSchema.parse({
      schema_version: 1,
      dish_id: draftId,
      dish_revision_id: photoId,
      width: 64,
      height: 64,
      layers: layers.map((layer) => ({
        url: `https://portion-ingestion.invalid/${layer.name}`,
        depth: layer.depth,
        sha256: digest(layer.bytes),
        size_bytes: layer.bytes.length,
      })),
    });
    const prepared = prepareApprovedPortion(
      {
        venueId: venue,
        dishId: soupId,
        dishRevisionId: soupRevision,
        publicationEligible: false,
        portion: privatePortion,
        layers: layers.map((layer) => ({
          name: layer.name,
          sha256: digest(layer.bytes),
          size_bytes: layer.bytes.length,
          base64: layer.bytes.toString('base64'),
        })),
        approval: {
          schema_version: 1,
          status: 'approved',
          source_sha256: hash,
          portion_sha256: digest(Buffer.from(JSON.stringify(privatePortion))),
          approved_by: draftId,
          approved_at: '2026-11-17T19:00:00.000Z',
        },
      },
      {
        venueId: venue,
        dishId: soupId,
        dishRevisionId: soupRevision,
        draftId,
        photoId,
        sourceHash: hash,
        assetBaseUrl: 'https://assets.example.test',
        sourceDimensions: { width: 800, height: 800 },
        portionCalibration: plate,
      },
    );
    const input = await request([{ dish_id: soupId, portion: prepared.portion }]);
    const run = (approved: ApprovedDishSource) =>
      produceMenuBundle(input, new Map([[soupId, approved]]), new Map(), {
        ownerPhotos: new Map([[soupId, photo({ width: 800, height: 800 })]]),
        ownerPortions: new Map([[soupId, prepared]]),
        missingPhoto: 'text_only',
      });
    const approved = source({ servingCount: null, servingSize: '24', portionCalibration: plate });
    const bundle = (await run(approved)).bundle;
    expect(bundle.categories[0]!.dishes[0]).toMatchObject({
      portion: { physical_size: { plate } },
    });
    for (const changed of [
      { portionCalibration: null },
      { portionCalibration: { ...plate, width_mm: 280, depth_mm: 280 }, servingSize: '28' },
      { servingSize: '28' },
      { servingCount: 2 },
    ])
      await expect(run({ ...approved, ...changed })).rejects.toMatchObject({
        code: 'asset_revision_mismatch',
      });
  });

  it('rejects a caller-supplied portion association that never passed private approval validation', async () => {
    const input = await request([
      {
        dish_id: soupId,
        portion: {
          schema_version: 1,
          dish_id: soupId,
          dish_revision_id: soupRevision,
          width: 128,
          height: 128,
          layers: [0, 1].map((depth) => ({
            url: `https://assets.example.test/${depth}`,
            sha256: hash,
            size_bytes: 10,
            depth,
          })),
        },
      },
    ]);
    const portion = input.categories[0]!.dishes[0]!.portion!;
    await expect(
      produceMenuBundle(input, new Map([[soupId, source()]]), new Map(), {
        ownerPhotos: new Map([[soupId, photo()]]),
        missingPhoto: 'text_only',
        ownerPortions: new Map([[soupId, { portion, files: [] }]]),
      }),
    ).rejects.toMatchObject({ code: 'asset_revision_mismatch' });
  });
  it('uses the photo approved on the revision, and text-only for a dish without one', async () => {
    const produced = await produceMenuBundle(
      await request([{ dish_id: soupId }, { dish_id: saladId }]),
      new Map([
        [soupId, source()],
        [
          saladId,
          source({
            dishId: saladId,
            dishRevisionId: saladRevision,
            name: 'Fictional Side Salad',
            approvedPhotoId: null,
          }),
        ],
      ]),
      new Map(),
      { ownerPhotos: new Map([[soupId, photo()]]), missingPhoto: 'text_only' },
    );
    const [soup, salad] = produced.bundle.categories[0]!.dishes;
    expect(soup).toMatchObject({
      dish_id: soupId,
      dish_revision_id: soupRevision,
      complete: true,
      serving_count: 2,
      allergens: ['milk'],
      images: { card: { url: photo().url, width: 800, height: 600, alt: 'Photo of the dish' } },
    });
    expect(salad).toMatchObject({ dish_id: saladId, complete: true, images: null });
    expect(produced.diagnostics).toEqual([]);
    expect(produced.bundleUrl).toBe(
      `${origin}${PREPARED_BUNDLE_PATH}/${venue}/${await ownerMenuId(venue)}/${produced.menuRevisionId}.json`,
    );
  });

  it('refuses a photo from another revision or not the selected one, and never calibrates it', async () => {
    const run = (sources: ApprovedDishSource, owner: OwnerApprovedPhoto, portion?: unknown) =>
      request([{ dish_id: soupId, ...(portion ? { portion } : {}) }]).then((req) =>
        produceMenuBundle(req, new Map([[soupId, sources]]), new Map(), {
          ownerPhotos: new Map([[soupId, owner]]),
          missingPhoto: 'text_only',
        }),
      );
    await expect(run(source(), photo({ dishRevisionId: saladRevision }))).rejects.toBeInstanceOf(
      BundleProducerError,
    );
    await expect(run(source({ approvedPhotoId: null }), photo())).rejects.toMatchObject({
      code: 'asset_revision_mismatch',
    });
    await expect(
      run(source({ approvedPhotoId: '33333333-3333-4333-8333-333333333339' }), photo()),
    ).rejects.toMatchObject({ code: 'asset_revision_mismatch' });
  });

  it('keeps the operator path strict: no photo is still an identity-only placeholder', async () => {
    const produced = await produceMenuBundle(
      await request([{ dish_id: soupId }]),
      new Map([[soupId, source({ approvedPhotoId: null })]]),
      new Map(),
    );
    expect(produced.bundle.categories[0]!.dishes[0]).toEqual({
      dish_id: soupId,
      dish_revision_id: soupRevision,
      complete: false,
    });
    expect(produced.diagnostics).toEqual([{ dishId: soupId, code: 'asset_missing' }]);
  });

  it('keeps unknown allergens unknown (null), never an allergen-free claim', async () => {
    const produced = await produceMenuBundle(
      await request([{ dish_id: soupId }]),
      new Map([[soupId, source({ approvedAllergens: null })]]),
      new Map(),
      { ownerPhotos: new Map([[soupId, photo()]]), missingPhoto: 'text_only' },
    );
    expect(produced.bundle.categories[0]!.dishes[0]).toMatchObject({ allergens: null });
  });
});

describe('S13 preview reads owner-prepared bundles from its own bucket', () => {
  it('reads the stored bytes without fetching and accepts its own photo and logo addresses', async () => {
    const req = await request([{ dish_id: soupId }]);
    req.restaurant.logo = {
      url: `${origin}${PREPARED_ASSET_PATH}/${venue}/logo/${hash}.png`,
      width: 8,
      height: 4,
      alt: 'Synthetic Cafe logo',
    };
    const built = await produceMenuBundle(req, new Map([[soupId, source()]]), new Map(), {
      ownerPhotos: new Map([[soupId, photo()]]),
      missingPhoto: 'text_only',
    });
    const menu = {
      venueId: venue,
      menuId: req.menu_id,
      menuRevisionId: built.menuRevisionId,
      contentApprovalId: built.contentApprovalId,
      assetApprovalId: built.assetApprovalId,
      contentHash: built.contentHash,
      assetManifestHash: built.assetManifestHash,
      bundleUrl: built.bundleUrl,
      reviewVersion: 0,
      publicationVersion: 0,
      publishedRevisionId: null,
    };
    const reads: string[] = [];
    const send = async () => {
      throw new Error('must not fetch its own bundle');
    };
    const content = await fetchPreparedMenu(menu, send as unknown as typeof fetch, {
      origin,
      read: async (key) => {
        reads.push(key);
        return built.bytes;
      },
    });
    expect(content.menu_revision_id).toBe(built.menuRevisionId);
    expect(reads).toEqual([`prepared-menus/${venue}/${req.menu_id}/${built.menuRevisionId}.json`]);
    // A bundle address for another revision, or another host's bundle, is refused.
    await expect(
      fetchPreparedMenu({ ...menu, menuRevisionId: req.menu_id }, send as unknown as typeof fetch, {
        origin,
        read: async () => built.bytes,
      }),
    ).rejects.toThrow();
    await expect(
      fetchPreparedMenu(menu, send as unknown as typeof fetch, {
        origin: 'https://other.example.test',
        read: async () => built.bytes,
      }),
    ).rejects.toThrow();
  });
});

describe('Part A HTTP boundary', () => {
  const venueId = '00000000-0000-4000-8000-000000000001';
  const actorId = '00000000-0000-4000-8000-000000000002';
  const rev = '00000000-0000-4000-8000-000000000003';
  const headers = { Authorization: 'Bearer synthetic-only' };
  const env = { APP_ENV: 'staging' };

  it('prepares only for a signed-in actor on staging/local, with the request origin', async () => {
    const { createApp } = await import('./index');
    const prepareOwnerMenu = vi.fn(async () => ({
      menuId: rev,
      menuRevisionId: rev,
      completeDishes: 1,
      diagnostics: [],
      status: 'inserted' as const,
    }));
    const app = createApp({ verify: async () => actorId, execute: vi.fn(), prepareOwnerMenu });
    const path = `/venues/${venueId}/prepared-menus/prepare`;
    expect((await app.request(path, { method: 'POST' }, env)).status).toBe(401);
    expect(
      (await app.request(path, { method: 'POST', headers }, { APP_ENV: 'production' })).status,
    ).toBe(404);
    expect(prepareOwnerMenu).not.toHaveBeenCalled();
    const ok = await app.request(
      `https://api.example.test${path}`,
      { method: 'POST', headers },
      env,
    );
    expect(ok.status).toBe(200);
    expect(prepareOwnerMenu).toHaveBeenCalledWith(
      actorId,
      venueId,
      'https://api.example.test',
      env,
    );
  });

  it('serves authorized public bytes without caching, and 404s otherwise', async () => {
    const { createApp } = await import('./index');
    const readPreparedBundle = vi.fn(async (_v: string, _m: string, r: string) =>
      r === rev ? new TextEncoder().encode('{"ok":true}') : null,
    );
    const readPreparedAsset = vi.fn(async () => ({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: 'image/png',
    }));
    const readPreparedLogo = vi.fn(async () => ({
      bytes: new Uint8Array([4, 5, 6]),
      contentType: 'image/png',
    }));
    const app = createApp({
      verify: async () => actorId,
      execute: vi.fn(),
      readPreparedBundle,
      readPreparedAsset,
      readPreparedLogo,
    });
    const bundle = await app.request(
      `/public/prepared-bundles/${venueId}/${venueId}/${rev}.json`,
      { headers: { Origin: 'https://peekaplate-diner-staging.pages.dev' } },
      env,
    );
    expect(bundle.status).toBe(200);
    expect(bundle.headers.get('Cache-Control')).toBe('no-store');
    expect(bundle.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://peekaplate-diner-staging.pages.dev',
    );
    expect(await bundle.text()).toBe('{"ok":true}');
    expect(
      (await app.request(`/public/prepared-bundles/${venueId}/${venueId}/${venueId}.json`, {}, env))
        .status,
    ).toBe(404);
    expect(
      (await app.request(`/public/prepared-bundles/${venueId}/${venueId}/../x.json`, {}, env))
        .status,
    ).toBe(404);
    const dishPhoto = await app.request(
      `/public/prepared-assets/${venueId}/${rev}/${'a'.repeat(64)}`,
      {},
      env,
    );
    expect(dishPhoto.status).toBe(200);
    expect(dishPhoto.headers.get('Content-Type')).toBe('image/png');
    expect(dishPhoto.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(
      (await app.request(`/public/prepared-assets/${venueId}/${rev}/not-a-hash`, {}, env)).status,
    ).toBe(404);
    const logo = await app.request(
      `/public/prepared-assets/${venueId}/logo/${'b'.repeat(64)}.png`,
      {},
      env,
    );
    expect(logo.status).toBe(200);
    expect(readPreparedLogo).toHaveBeenCalledWith(venueId, 'b'.repeat(64), 'png', env);
    expect(readPreparedAsset).toHaveBeenCalledTimes(1);
    for (const bad of [`logo/${'b'.repeat(64)}.gif`, 'logo/short.png'])
      expect((await app.request(`/public/prepared-assets/${venueId}/${bad}`, {}, env)).status).toBe(
        404,
      );
  });
});
