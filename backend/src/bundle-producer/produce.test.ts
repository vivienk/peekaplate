import {
  canonicalJson,
  PublicMenuContentBundleSchema,
  sha256,
  verifyPublicMenuContentBytes,
} from '@peekaplate/contracts';
import { describe, expect, it } from 'vitest';
import { derivedUuid } from './ids';
import { normalizePrice } from './price';
import {
  type ApprovedDishSource,
  BundleProducerError,
  type ProducedMenuBundle,
  produceMenuBundle,
  type VerifiedT0Asset,
} from './produce';
import { type MenuBundleRequest, MenuBundleRequestSchema, T0AssetManifestSchema } from './request';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const VENUE = id(1);
const MENU = id(2);
const STARTERS = id(10);
const MAINS = id(11);
const LEEKS = id(20);
const CHICKEN = id(21);
const SOUP = id(22);
const REVIEWER = 'c0ffee00-0000-4000-8000-00000000beef';
const assetId = (n: number) => `t0_${String(n).padStart(32, '0')}`;

type RequestInput = Record<string, unknown> & {
  categories: (Record<string, unknown> & { dishes: Record<string, unknown>[] })[];
};

function requestInput(): RequestInput {
  return {
    schema_version: 1,
    venue_id: VENUE,
    menu_id: MENU,
    restaurant: { name: 'Synthetic Bistro', logo: null },
    bundle_base_url: 'https://bundles.example.test/menus',
    asset_base_url: 'https://assets.example.test/t0',
    categories: [
      {
        category_id: STARTERS,
        name: 'Starters',
        dishes: [
          {
            dish_id: LEEKS,
            allergens: ['nuts'],
            dietary: ['vegan'],
            image_alt: 'Charred leeks on a white plate',
            t0_asset_id: assetId(1),
          },
          {
            dish_id: SOUP,
            allergens: null,
            dietary: [],
            image_alt: null,
            t0_asset_id: null,
          },
        ],
      },
      {
        category_id: MAINS,
        name: 'Mains',
        dishes: [
          {
            dish_id: CHICKEN,
            allergens: null,
            dietary: [],
            image_alt: 'Roast chicken with green sauce',
            t0_asset_id: assetId(2),
          },
        ],
      },
    ],
  };
}

function parseRequest(input: unknown): MenuBundleRequest {
  return MenuBundleRequestSchema.parse(input);
}

function dishSource(dishId: string, revision: number, overrides: Partial<ApprovedDishSource> = {}) {
  return {
    dishId,
    dishRevisionId: id(revision),
    name: `Dish ${revision}`,
    description: `Approved description ${revision}.`,
    priceAmount: '14.5',
    priceCurrency: 'USD',
    ingredients: ['Leeks', 'Hazelnut romesco'],
    reviewState: 'none',
    ...overrides,
  } satisfies ApprovedDishSource;
}

function sources(overrides: Record<string, Partial<ApprovedDishSource>> = {}) {
  return new Map<string, ApprovedDishSource>([
    [LEEKS, dishSource(LEEKS, 120, overrides[LEEKS])],
    [CHICKEN, dishSource(CHICKEN, 121, { priceAmount: '28', ...overrides[CHICKEN] })],
    [SOUP, dishSource(SOUP, 122, overrides[SOUP])],
  ]);
}

function manifest(n: number, dishId: string, revisionId: string, shaSeed = 'a') {
  return T0AssetManifestSchema.parse({
    schema_version: 1,
    asset_id: assetId(n),
    tier: 'T0',
    dish: { dish_id: dishId, revision_id: revisionId },
    variants: [
      { name: 'card-480', format: 'webp', path: 'card-480.webp', w: 480, h: 360 },
      { name: 'card-480', format: 'jpeg', path: 'card-480.jpg', w: 480, h: 360 },
      { name: 'detail-1280', format: 'webp', path: 'detail-1280.webp', w: 1280, h: 960 },
      { name: 'detail-1280', format: 'jpeg', path: 'detail-1280.jpg', w: 1280, h: 960 },
    ].map(({ w, h, ...variant }, index) => ({
      ...variant,
      sha256: `${shaSeed}${index}`.padEnd(64, '0'),
      size_bytes: 1000,
      width: w,
      height: h,
      quality: 80,
    })),
    source: {
      sha256: 'b'.repeat(64),
      capture_evidence: 'Synthetic fixture; not a real restaurant capture.',
    },
    review: { status: 'needs_review' },
    publication: { eligible: false },
  });
}

function assets(overrides: Record<string, VerifiedT0Asset> = {}) {
  return new Map<string, VerifiedT0Asset>([
    [assetId(1), { manifest: manifest(1, LEEKS, id(120)) }],
    [assetId(2), { manifest: manifest(2, CHICKEN, id(121)) }],
    ...Object.entries(overrides),
  ]);
}

async function produceDefault() {
  return produceMenuBundle(parseRequest(requestInput()), sources(), assets());
}

it('uses the reviewed allergen/category snapshot and refuses a different category', async () => {
  const result = await produceMenuBundle(
    parseRequest(requestInput()),
    sources({ [LEEKS]: { approvedAllergens: ['milk'], approvedCategory: 'Starters' } }),
    assets(),
  );
  const leek = dishes(result).find((dish) => dish.dish_id === LEEKS);
  expect(leek?.complete && leek.allergens).toEqual(['milk']);
  await expect(
    produceMenuBundle(
      parseRequest(requestInput()),
      sources({ [LEEKS]: { approvedAllergens: [], approvedCategory: 'Unapproved category' } }),
      assets(),
    ),
  ).rejects.toMatchObject({ code: 'invalid_request' });
});

async function producerError(promise: Promise<unknown>) {
  const error = await promise.catch((caught: unknown) => caught);
  if (!(error instanceof BundleProducerError)) throw error;
  return error.code;
}

function dishes(result: ProducedMenuBundle) {
  return result.bundle.categories.flatMap((category) => category.dishes);
}

describe('S4-RES bundle producer: AC-S1 shape', () => {
  it('normalizes uppercase UUIDs in request identities', () => {
    const input = requestInput();
    input.venue_id = 'ABCDEF01-ABCD-4ABC-8ABC-ABCDEF012345';
    input.menu_id = 'ABCDEF02-ABCD-4ABC-8ABC-ABCDEF012345';
    input.categories[0]!.category_id = 'ABCDEF03-ABCD-4ABC-8ABC-ABCDEF012345';
    input.categories[0]!.dishes[0]!.dish_id = 'ABCDEF04-ABCD-4ABC-8ABC-ABCDEF012345';
    const parsed = parseRequest(input);
    expect(parsed.venue_id).toBe('abcdef01-abcd-4abc-8abc-abcdef012345');
    expect(parsed.menu_id).toBe('abcdef02-abcd-4abc-8abc-abcdef012345');
    expect(parsed.categories[0]!.category_id).toBe('abcdef03-abcd-4abc-8abc-abcdef012345');
    expect(parsed.categories[0]!.dishes[0]!.dish_id).toBe('abcdef04-abcd-4abc-8abc-abcdef012345');
  });

  it('produces a verified empty menu with normalized venue and menu IDs', async () => {
    const input = requestInput();
    input.venue_id = 'ABCDEF01-ABCD-4ABC-8ABC-ABCDEF012345';
    input.menu_id = 'ABCDEF02-ABCD-4ABC-8ABC-ABCDEF012345';
    input.categories = [];
    const result = await produceMenuBundle(parseRequest(input), new Map(), new Map());
    expect(result.bundle.venue_id).toBe('abcdef01-abcd-4abc-8abc-abcdef012345');
    expect(result.bundle.menu_id).toBe('abcdef02-abcd-4abc-8abc-abcdef012345');
    expect(result.bundle.categories).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(PublicMenuContentBundleSchema.parse(result.bundle)).toEqual(result.bundle);
    await expect(verifyPublicMenuContentBytes(result.bytes, result.contentHash)).resolves.toEqual(
      result.bundle,
    );
  });

  it.each(['not-a-uuid', 'abcdef01-abcd-4abc-8abc-abcdef012345\u0000'])(
    'rejects invalid UUID %j',
    (value) => {
      const input = requestInput();
      input.venue_id = value;
      expect(MenuBundleRequestSchema.safeParse(input).success).toBe(false);
    },
  );

  it('rejects duplicate dish IDs across categories after case normalization', () => {
    const input = requestInput();
    input.categories[0]!.dishes[0]!.dish_id = 'ABCDEF04-ABCD-4ABC-8ABC-ABCDEF012345';
    input.categories[1]!.dishes[0]!.dish_id = 'abcdef04-abcd-4abc-8abc-abcdef012345';
    expect(MenuBundleRequestSchema.safeParse(input).success).toBe(false);
  });

  it('builds a schema-valid bundle with exact identities, URLs, alt text and dimensions', async () => {
    const result = await produceDefault();
    const { bundle } = result;

    expect(PublicMenuContentBundleSchema.parse(bundle)).toEqual(bundle);
    expect(bundle.venue_id).toBe(VENUE);
    expect(bundle.menu_id).toBe(MENU);
    expect(bundle.menu_revision_id).toBe(result.menuRevisionId);
    expect(bundle.categories.map((category) => category.category_id)).toEqual([STARTERS, MAINS]);
    expect(dishes(result).map((dish) => dish.dish_id)).toEqual([LEEKS, SOUP, CHICKEN]);

    const leeks = dishes(result)[0];
    if (!leeks?.complete) throw new Error('leeks must be complete');
    expect(leeks.dish_revision_id).toBe(id(120));
    expect(leeks.price).toEqual({ amount: '14.50', currency: 'USD' });
    expect(leeks.allergens).toEqual(['nuts']);
    expect(leeks.dietary).toEqual(['vegan']);
    expect(leeks.ingredients.map((ingredient) => ingredient.name)).toEqual([
      'Leeks',
      'Hazelnut romesco',
    ]);
    expect(leeks.ingredients[0]?.ingredient_id).toBe(
      await derivedUuid('ingredient:v1', id(120), '0', 'Leeks'),
    );
    expect(leeks.images).toEqual({
      card: {
        url: `https://assets.example.test/t0/${assetId(1)}/card-480.webp`,
        width: 480,
        height: 360,
        alt: 'Charred leeks on a white plate',
      },
      detail: {
        url: `https://assets.example.test/t0/${assetId(1)}/detail-1280.webp`,
        width: 1280,
        height: 960,
        alt: 'Charred leeks on a white plate',
      },
    });

    const chicken = dishes(result)[2];
    if (!chicken?.complete) throw new Error('chicken must be complete');
    expect(chicken.price.amount).toBe('28.00');
    expect(chicken.allergens).toBeNull();

    expect(dishes(result)[1]).toEqual({
      dish_id: SOUP,
      dish_revision_id: id(122),
      complete: false,
    });
    expect(Object.keys(dishes(result)[1] ?? {})).toHaveLength(3);
    expect(result.diagnostics).toEqual([
      { dishId: SOUP, code: 'alt_missing' },
      { dishId: SOUP, code: 'asset_missing' },
    ]);
  });

  it('hashes the exact canonical bytes and derives approvals and the URL from them', async () => {
    const result = await produceDefault();
    const text = new TextDecoder().decode(result.bytes);

    expect(text).toBe(canonicalJson(result.bundle));
    expect(text.endsWith('\n')).toBe(false);
    expect(result.contentHash).toBe(await sha256(result.bytes));
    const { menu_revision_id: _revision, ...withoutRevision } = result.bundle;
    expect(result.menuRevisionId).toBe(
      await derivedUuid('menu-revision:v1', canonicalJson(withoutRevision)),
    );
    expect(result.contentApprovalId).toBe(
      await derivedUuid('content-approval:v1', result.contentHash),
    );
    expect(result.assetApprovalId).toBe(
      await derivedUuid('asset-approval:v1', result.assetManifestHash),
    );
    expect(result.bundleUrl).toBe(
      `https://bundles.example.test/menus/${VENUE}/${MENU}/${result.menuRevisionId}.json`,
    );
    await expect(verifyPublicMenuContentBytes(result.bytes, result.contentHash)).resolves.toEqual(
      result.bundle,
    );
  });

  it('commits the asset manifest hash to complete dishes only, sorted by dish ID', async () => {
    const result = await produceDefault();
    const leeks = manifest(1, LEEKS, id(120));
    const chicken = manifest(2, CHICKEN, id(121));
    const entry = (dishId: string, revision: number, m: typeof leeks) => {
      const card = m.variants.find((v) => v.name === 'card-480' && v.format === 'webp');
      const detail = m.variants.find((v) => v.name === 'detail-1280' && v.format === 'webp');
      return {
        dish_id: dishId,
        dish_revision_id: id(revision),
        asset_id: m.asset_id,
        card: {
          url: `https://assets.example.test/t0/${m.asset_id}/card-480.webp`,
          sha256: card?.sha256,
          width: card?.width,
          height: card?.height,
        },
        detail: {
          url: `https://assets.example.test/t0/${m.asset_id}/detail-1280.webp`,
          sha256: detail?.sha256,
          width: detail?.width,
          height: detail?.height,
        },
      };
    };
    const expected = canonicalJson({
      schema_version: 1,
      assets: [entry(LEEKS, 120, leeks), entry(CHICKEN, 121, chicken)],
    });
    expect(result.assetManifestHash).toBe(await sha256(expected));
  });
});

describe('S4-RES bundle producer: AC-S2 determinism', () => {
  it('produces identical bytes and IDs on repeat runs', async () => {
    const first = await produceDefault();
    const second = await produceDefault();
    expect(Buffer.from(second.bytes).equals(Buffer.from(first.bytes))).toBe(true);
    expect({ ...second, bytes: null }).toEqual({ ...first, bytes: null });
  });

  const contentChanges: [string, () => Promise<ProducedMenuBundle>][] = [
    [
      'name',
      () =>
        produceMenuBundle(
          parseRequest(requestInput()),
          sources({ [LEEKS]: { name: 'Charred Leeks II' } }),
          assets(),
        ),
    ],
    [
      'description',
      () =>
        produceMenuBundle(
          parseRequest(requestInput()),
          sources({ [LEEKS]: { description: 'Changed.' } }),
          assets(),
        ),
    ],
    [
      'price',
      () =>
        produceMenuBundle(
          parseRequest(requestInput()),
          sources({ [LEEKS]: { priceAmount: '14.75' } }),
          assets(),
        ),
    ],
    [
      'ingredient',
      () =>
        produceMenuBundle(
          parseRequest(requestInput()),
          sources({ [LEEKS]: { ingredients: ['Leeks', 'Romesco'] } }),
          assets(),
        ),
    ],
    [
      'allergens null to []',
      () => {
        const input = requestInput();
        (input.categories[1]?.dishes[0] as Record<string, unknown>).allergens = [];
        return produceMenuBundle(parseRequest(input), sources(), assets());
      },
    ],
    [
      'dietary',
      () => {
        const input = requestInput();
        (input.categories[0]?.dishes[0] as Record<string, unknown>).dietary = ['vegetarian'];
        return produceMenuBundle(parseRequest(input), sources(), assets());
      },
    ],
    [
      'alt',
      () => {
        const input = requestInput();
        (input.categories[0]?.dishes[0] as Record<string, unknown>).image_alt = 'Other alt';
        return produceMenuBundle(parseRequest(input), sources(), assets());
      },
    ],
    [
      'asset base url',
      () => {
        const input = requestInput();
        input.asset_base_url = 'https://cdn.example.test/t0';
        return produceMenuBundle(parseRequest(input), sources(), assets());
      },
    ],
    [
      'dish revision id',
      () =>
        produceMenuBundle(
          parseRequest(requestInput()),
          sources({ [SOUP]: { dishRevisionId: id(999) } }),
          assets(),
        ),
    ],
  ];

  for (const [label, run] of contentChanges) {
    it(`a ${label} change yields a new content hash and menu revision`, async () => {
      const base = await produceDefault();
      const changed = await run();
      expect(changed.contentHash).not.toBe(base.contentHash);
      expect(changed.menuRevisionId).not.toBe(base.menuRevisionId);
      expect(changed.bundleUrl).not.toBe(base.bundleUrl);
    });
  }

  it('an asset-only change yields a new asset manifest hash and asset approval', async () => {
    const base = await produceDefault();
    const changed = await produceMenuBundle(
      parseRequest(requestInput()),
      sources(),
      assets({ [assetId(2)]: { manifest: manifest(2, CHICKEN, id(121), 'd') } }),
    );
    expect(changed.assetManifestHash).not.toBe(base.assetManifestHash);
    expect(changed.assetApprovalId).not.toBe(base.assetApprovalId);
    expect(changed.menuRevisionId).toBe(base.menuRevisionId);
    expect(changed.contentHash).toBe(base.contentHash);
  });
});

describe('S4-RES bundle producer: AC-S3 rejection and placeholders', () => {
  it('keeps private capture evidence and the source digest out of public bytes', async () => {
    const text = new TextDecoder().decode((await produceDefault()).bytes);
    expect(text).not.toContain('capture_evidence');
    expect(text).not.toContain('Synthetic fixture; not a real restaurant capture.');
    expect(text).not.toContain('b'.repeat(64));
  });

  it.each([
    ['missing source', undefined],
    ['missing capture evidence', { sha256: 'b'.repeat(64) }],
    ['blank capture evidence', { sha256: 'b'.repeat(64), capture_evidence: '   ' }],
    ['NUL capture evidence', { sha256: 'b'.repeat(64), capture_evidence: '\u0000' }],
    ['invalid source digest', { sha256: 'invalid', capture_evidence: 'Synthetic fixture' }],
  ])('rejects a T0 manifest with %s', (_label, source) => {
    const candidate = { ...manifest(1, LEEKS, id(120)), source };
    expect(T0AssetManifestSchema.safeParse(candidate).success).toBe(false);
  });

  it('rejects a manifest that substitutes the private original for a delivery variant', () => {
    const candidate = manifest(1, LEEKS, id(120));
    candidate.variants[0]!.path = 'source.jpg';
    expect(T0AssetManifestSchema.safeParse(candidate).success).toBe(false);
  });

  it('rejects duplicate dish or category IDs, unknown fields and display labels', () => {
    const duplicateDish = requestInput();
    duplicateDish.categories[1]?.dishes.push({ ...duplicateDish.categories[0]?.dishes[0] });
    const duplicateCategory = requestInput();
    (duplicateCategory.categories[1] as Record<string, unknown>).category_id = STARTERS;
    const unknownField = { ...requestInput(), published_by: REVIEWER };
    const label = requestInput();
    (label.categories[0]?.dishes[0] as Record<string, unknown>).allergens = ['Peanuts'];
    for (const input of [duplicateDish, duplicateCategory, unknownField, label]) {
      expect(MenuBundleRequestSchema.safeParse(input).success).toBe(false);
    }
  });

  it('wraps an invalid request as invalid_request', async () => {
    expect(
      await producerError(produceMenuBundle({} as MenuBundleRequest, sources(), assets())),
    ).toBe('invalid_request');
  });

  it('fails when a requested dish has no approved source in this tenant', async () => {
    const missing = sources();
    missing.delete(CHICKEN);
    expect(
      await producerError(produceMenuBundle(parseRequest(requestInput()), missing, assets())),
    ).toBe('dish_not_found');
  });

  it('fails when an asset manifest belongs to another dish', async () => {
    const wrong = assets({ [assetId(1)]: { manifest: manifest(1, CHICKEN, id(121)) } });
    expect(
      await producerError(produceMenuBundle(parseRequest(requestInput()), sources(), wrong)),
    ).toBe('asset_dish_mismatch');
  });

  const gaps: [string, Partial<ApprovedDishSource>, string][] = [
    ['blank description', { description: '   ' }, 'description_missing'],
    ['overlong description', { description: 'x'.repeat(4001) }, 'description_missing'],
    ['description containing NUL', { description: 'Dish\u0000description' }, 'description_missing'],
    ['null price', { priceAmount: null }, 'price_missing'],
    ['over-precise price', { priceAmount: '14.555' }, 'price_not_representable'],
    ['missing currency', { priceCurrency: null }, 'currency_missing'],
    ['invalid currency', { priceCurrency: 'usd' }, 'currency_missing'],
    ['whitespace currency', { priceCurrency: '   ' }, 'currency_missing'],
    ['no ingredients', { ingredients: null }, 'ingredients_missing'],
    ['empty ingredients', { ingredients: [] }, 'ingredients_missing'],
    ['blank ingredient', { ingredients: ['Leeks', ' '] }, 'ingredients_missing'],
    [
      'ingredient longer than 160 characters',
      { ingredients: ['x'.repeat(161)] },
      'ingredients_missing',
    ],
    ['too many ingredients', { ingredients: Array(101).fill('Leeks') }, 'ingredients_missing'],
    ['ingredient containing NUL', { ingredients: ['Leek\u0000s'] }, 'ingredients_missing'],
    ['RES-01.2 incomplete', { reviewState: 'incomplete' }, 'review_incomplete'],
  ];

  for (const [label, override, code] of gaps) {
    it(`turns a dish with ${label} into an identity-only placeholder`, async () => {
      const result = await produceMenuBundle(
        parseRequest(requestInput()),
        sources({ [LEEKS]: override }),
        assets(),
      );
      expect(dishes(result)[0]).toEqual({
        dish_id: LEEKS,
        dish_revision_id: id(120),
        complete: false,
      });
      expect(result.diagnostics).toContainEqual({ dishId: LEEKS, code });
    });
  }

  it('accepts a 4000-character description and valid uppercase currency', async () => {
    const result = await produceMenuBundle(
      parseRequest(requestInput()),
      sources({ [LEEKS]: { description: 'x'.repeat(4000), priceCurrency: 'USD' } }),
      assets(),
    );
    const dish = dishes(result)[0];
    if (!dish?.complete) throw new Error('Expected complete dish');
    expect(dish.description).toBe('x'.repeat(4000));
    expect(dish.price.currency).toBe('USD');
  });

  it('accepts 100 ingredients and a 160-character trimmed name', async () => {
    const names = [` ${'x'.repeat(160)} `, ...Array(99).fill('Leeks')];
    const result = await produceMenuBundle(
      parseRequest(requestInput()),
      sources({ [LEEKS]: { ingredients: names } }),
      assets(),
    );
    const dish = dishes(result)[0];
    expect(dish?.complete).toBe(true);
    if (!dish?.complete) throw new Error('Expected complete dish');
    expect(dish.ingredients).toHaveLength(100);
    expect(dish.ingredients[0]?.name).toBe('x'.repeat(160));
  });

  it('turns a dish whose asset is for an older revision into a placeholder', async () => {
    const result = await produceMenuBundle(
      parseRequest(requestInput()),
      sources(),
      assets({ [assetId(1)]: { manifest: manifest(1, LEEKS, id(900)) } }),
    );
    expect(dishes(result)[0]?.complete).toBe(false);
    expect(result.diagnostics).toContainEqual({ dishId: LEEKS, code: 'asset_revision_mismatch' });
  });

  it('omits a RES-01.2 rejected dish from the bundle', async () => {
    const result = await produceMenuBundle(
      parseRequest(requestInput()),
      sources({ [CHICKEN]: { reviewState: 'rejected' } }),
      assets(),
    );
    expect(dishes(result).map((dish) => dish.dish_id)).toEqual([LEEKS, SOUP]);
    expect(result.bundle.categories[1]?.dishes).toEqual([]);
    expect(result.diagnostics).toContainEqual({ dishId: CHICKEN, code: 'candidate_rejected' });
  });

  it('keeps unreviewed allergens null instead of an empty list', async () => {
    const result = await produceDefault();
    const chicken = dishes(result)[2];
    expect(chicken?.complete && chicken.allergens).toBeNull();
    expect(new TextDecoder().decode(result.bytes)).toContain('"allergens":null');
  });

  it('never copies private review or extraction fields into the bundle bytes', async () => {
    const leaky = sources();
    for (const [key, source] of leaky) {
      leaky.set(key, {
        ...source,
        reviewed_by: REVIEWER,
        review_note: 'private note',
        source_text: 'Leeks 14.5',
        evidence: { page: 1 },
        price_text: '$14.50',
        candidate_id: 'cand-1',
        job_id: id(777),
      } as ApprovedDishSource);
    }
    const text = new TextDecoder().decode(
      (await produceMenuBundle(parseRequest(requestInput()), leaky, assets())).bytes,
    );
    for (const forbidden of [
      'reviewed_by',
      'review_note',
      'source_text',
      'evidence',
      'price_text',
      'candidate_id',
      'job_id',
      REVIEWER,
      'private note',
      id(777),
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });
});

describe('price normalisation', () => {
  it.each([
    ['12.5', '12.50'],
    ['12', '12.00'],
    ['12.5000', '12.50'],
    ['0', '0.00'],
    ['007.10', '7.10'],
    ['99999999.99', '99999999.99'],
  ])('%s becomes %s', (input, expected) => {
    expect(normalizePrice(input)).toEqual({ ok: true, amount: expected });
  });

  it.each([
    ['12.555', 'price_not_representable'],
    ['100000000', 'price_not_representable'],
    ['-1', 'price_not_representable'],
    ['1e3', 'price_not_representable'],
    ['', 'price_not_representable'],
  ])('%s is rejected as %s', (input, reason) => {
    expect(normalizePrice(input)).toEqual({ ok: false, reason });
  });

  it('reports a null amount as missing', () => {
    expect(normalizePrice(null)).toEqual({ ok: false, reason: 'price_missing' });
  });
});

describe('derived UUIDs', () => {
  it('are stable, version 8 and RFC-variant', async () => {
    const value = await derivedUuid('menu-revision:v1', 'a', 'b');
    expect(value).toBe(await derivedUuid('menu-revision:v1', 'a', 'b'));
    expect(value).not.toBe(await derivedUuid('content-approval:v1', 'a', 'b'));
    expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
