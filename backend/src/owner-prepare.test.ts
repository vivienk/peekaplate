import { verifyPublicMenuContentBytes } from '@peekaplate/contracts';
import { describe, expect, it, vi } from 'vitest';
import { buildPreparedBundle, imageSize, ownerMenuId, type VerifiedDish } from './owner-prepare';
import { fetchPreparedMenu } from './owner-publication';

const venue = '11111111-1111-4111-8111-111111111111';
const origin = 'https://api.example.test';
const png = (width: number, height: number) => {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13], 0);
  bytes.set(
    [...'IHDR'].map((c) => c.charCodeAt(0)),
    12,
  );
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
};
const jpeg = (width: number, height: number) =>
  new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x04,
    0x00,
    0x00,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    0x03,
  ]);
const dish = (overrides: Partial<VerifiedDish> = {}): VerifiedDish => ({
  draftId: '22222222-2222-4222-8222-222222222221',
  draftVersion: 2,
  name: 'Fictional Lentil Soup',
  description: 'Slow cooked lentils with herbs.',
  category: 'Soups',
  priceAmount: '9.5',
  priceCurrency: 'CAD',
  ingredients: ['lentils', 'thyme'],
  allergens: ['milk'],
  photo: {
    id: '33333333-3333-4333-8333-333333333331',
    sha256: 'a'.repeat(64),
    width: 800,
    height: 600,
  },
  ...overrides,
});

describe('photo size from the approved bytes', () => {
  it('reads PNG and JPEG headers and rejects anything else', () => {
    expect(imageSize(png(1280, 960))).toEqual({ width: 1280, height: 960 });
    expect(imageSize(jpeg(640, 480))).toEqual({ width: 640, height: 480 });
    expect(imageSize(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(imageSize(png(0, 10))).toBeNull();
  });
});

describe('owner-prepared bundle (Part A)', () => {
  it('builds a verified dish exactly as the public bundle contract requires', async () => {
    const built = await buildPreparedBundle({
      venueId: venue,
      restaurantName: 'Synthetic Bridge Cafe',
      origin,
      dishes: [dish()],
    });
    const content = await verifyPublicMenuContentBytes(built.bytes, built.contentHash);
    expect(content.menu_id).toBe(await ownerMenuId(venue));
    expect(content.menu_revision_id).toBe(built.menuRevisionId);
    const [category] = content.categories;
    expect(category?.name).toBe('Soups');
    const [first] = category?.dishes ?? [];
    expect(first).toMatchObject({
      complete: true,
      name: 'Fictional Lentil Soup',
      price: { amount: '9.50', currency: 'CAD' },
      allergens: ['milk'],
      dietary: [],
    });
    if (!first?.complete) throw new Error('expected a complete dish');
    expect(first.images.card.url).toBe(
      `${origin}/public/prepared-assets/${venue}/33333333-3333-4333-8333-333333333331/${'a'.repeat(64)}`,
    );
    expect(first.images.card).toMatchObject({
      width: 800,
      height: 600,
      alt: 'Photo of Fictional Lentil Soup',
    });
    expect(built.bundleUrl).toBe(
      `${origin}/public/prepared-bundles/${venue}/${built.menuId}/${built.menuRevisionId}.json`,
    );
    expect(built.completeDishes).toBe(1);
    expect(built.diagnostics).toEqual([]);
  });

  it('is deterministic, and a changed dish gives a new revision', async () => {
    const input = { venueId: venue, restaurantName: 'Cafe', origin, dishes: [dish()] };
    const a = await buildPreparedBundle(input);
    const b = await buildPreparedBundle(input);
    expect(b.contentHash).toBe(a.contentHash);
    expect(b.menuRevisionId).toBe(a.menuRevisionId);
    const changed = await buildPreparedBundle({ ...input, dishes: [dish({ draftVersion: 3 })] });
    expect(changed.menuRevisionId).not.toBe(a.menuRevisionId);
  });

  it('turns incomplete verified dishes into identity-only placeholders with reasons', async () => {
    const built = await buildPreparedBundle({
      venueId: venue,
      restaurantName: 'Cafe',
      origin,
      dishes: [
        dish(),
        dish({ draftId: '22222222-2222-4222-8222-222222222222', photo: null, description: ' ' }),
        dish({
          draftId: '22222222-2222-4222-8222-222222222223',
          priceAmount: '1.999',
          ingredients: [],
        }),
        dish({ draftId: '22222222-2222-4222-8222-222222222224', category: null, allergens: null }),
      ],
    });
    const dishes = built.bundle.categories.flatMap((category) => category.dishes);
    expect(dishes.filter((value) => value.complete)).toHaveLength(1);
    expect(dishes.filter((value) => !value.complete)).toHaveLength(3);
    expect(built.diagnostics.map((value) => value.code).sort()).toEqual(
      [
        'category_missing',
        'description_missing',
        'ingredients_missing',
        'photo_missing',
        'price_not_representable',
      ].sort(),
    );
    expect(built.completeDishes).toBe(1);
  });

  it('keeps unknown allergens unknown (null), never an allergen-free claim', async () => {
    const built = await buildPreparedBundle({
      venueId: venue,
      restaurantName: 'Cafe',
      origin,
      dishes: [dish({ allergens: null })],
    });
    const [first] = built.bundle.categories[0]?.dishes ?? [];
    expect(first?.complete && first.allergens).toBeNull();
  });
});

describe('S13 preview reads owner-prepared bundles from its own bucket', () => {
  it('reads the stored bytes without fetching and accepts its own photo addresses', async () => {
    const built = await buildPreparedBundle({
      venueId: venue,
      restaurantName: 'Cafe',
      origin,
      dishes: [dish()],
    });
    const menu = {
      venueId: venue,
      menuId: built.menuId,
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
    expect(reads).toEqual([`prepared-menus/${venue}/${built.menuId}/${built.menuRevisionId}.json`]);
    // A bundle address for another revision, or another host's bundle, is refused.
    await expect(
      fetchPreparedMenu(
        { ...menu, menuRevisionId: built.menuId },
        send as unknown as typeof fetch,
        {
          origin,
          read: async () => built.bytes,
        },
      ),
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

  it('serves admitted bundles and approved photos immutably with diner CORS, and 404s otherwise', async () => {
    const { createApp } = await import('./index');
    const readPreparedBundle = vi.fn(async (_v: string, _m: string, r: string) =>
      r === rev ? new TextEncoder().encode('{"ok":true}') : null,
    );
    const readPreparedAsset = vi.fn(async () => ({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: 'image/png',
    }));
    const app = createApp({
      verify: async () => actorId,
      execute: vi.fn(),
      readPreparedBundle,
      readPreparedAsset,
    });
    const bundle = await app.request(
      `/public/prepared-bundles/${venueId}/${venueId}/${rev}.json`,
      { headers: { Origin: 'https://peekaplate-diner-staging.pages.dev' } },
      env,
    );
    expect(bundle.status).toBe(200);
    expect(bundle.headers.get('Cache-Control')).toContain('immutable');
    expect(bundle.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://peekaplate-diner-staging.pages.dev',
    );
    expect(await bundle.text()).toBe('{"ok":true}');
    const missing = await app.request(
      `/public/prepared-bundles/${venueId}/${venueId}/${venueId}.json`,
      {},
      env,
    );
    expect(missing.status).toBe(404);
    expect(
      (await app.request(`/public/prepared-bundles/${venueId}/${venueId}/../x.json`, {}, env))
        .status,
    ).toBe(404);
    const photo = await app.request(
      `/public/prepared-assets/${venueId}/${rev}/${'a'.repeat(64)}`,
      {},
      env,
    );
    expect(photo.status).toBe(200);
    expect(photo.headers.get('Content-Type')).toBe('image/png');
    expect(photo.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(
      (await app.request(`/public/prepared-assets/${venueId}/${rev}/not-a-hash`, {}, env)).status,
    ).toBe(404);
  });
});
