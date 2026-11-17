// Automatic menu preparation (Part A): after an owner verifies their dishes (S10/S11), this
// builds the public menu bundle from exactly the verified drafts and the owner-approved photos,
// stores the immutable bytes, and admits them for S13 through one narrow, owner-scoped database
// function. Nothing here approves or publishes: the owner still previews, confirms and publishes
// in S13. The operator path (pnpm produce:bundle --admit) is unchanged.
//
// Bundle rules follow the operator producer exactly where they overlap: the same canonical bytes,
// menu-revision / approval id derivation, price normalisation and completeness checks. Dishes
// that cannot be shown completely become identity-only placeholders, as in the producer.
import {
  canonicalJson,
  type PublicMenuAllergenCode,
  PublicMenuAllergenCodeSchema,
  type PublicMenuContentBundle,
  PublicMenuContentBundleSchema,
  type PublicMenuDish,
  sha256,
  verifyPublicMenuContentBytes,
} from '@peekaplate/contracts';
import type { Client } from 'pg';
import { derivedUuid } from './bundle-producer/ids';
import { normalizePrice } from './bundle-producer/price';
import { IngestionError } from './ingestion/repository';
import { beginAuthorizedOwner } from './publication-command';

export const PREPARED_BUNDLE_PATH = '/public/prepared-bundles';
export const PREPARED_ASSET_PATH = '/public/prepared-assets';
const PENDING_REVISION_ID = '00000000-0000-8000-8000-000000000000';
const MAX_PHOTO_BYTES = 12_000_000;

export type PreparedStorage = {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  put(
    key: string,
    bytes: ArrayBuffer,
    options?: { onlyIf?: { etagDoesNotMatch?: string }; httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
};

/** One verified dish draft with the owner's corrections already applied. */
export type VerifiedDish = {
  draftId: string;
  draftVersion: number;
  name: string;
  description: string | null;
  category: string | null;
  priceAmount: string | null;
  priceCurrency: string | null;
  ingredients: readonly string[] | null;
  allergens: readonly PublicMenuAllergenCode[] | null;
  photo: { id: string; sha256: string; width: number; height: number } | null;
};

export type PrepareDiagnostic = {
  draftId: string;
  code:
    | 'description_missing'
    | 'price_missing'
    | 'price_not_representable'
    | 'currency_missing'
    | 'ingredients_missing'
    | 'photo_missing'
    | 'category_missing';
};

export type PreparedBundle = {
  bundle: PublicMenuContentBundle;
  bytes: Uint8Array;
  contentHash: string;
  assetManifestHash: string;
  menuId: string;
  menuRevisionId: string;
  contentApprovalId: string;
  assetApprovalId: string;
  bundleUrl: string;
  completeDishes: number;
  diagnostics: PrepareDiagnostic[];
};

export const ownerMenuId = (venueId: string) => derivedUuid('owner-prepared-menu:v1', venueId);
export const bundleKey = (venueId: string, menuId: string, revisionId: string) =>
  `prepared-menus/${venueId}/${menuId}/${revisionId}.json`;
export const assetUrl = (origin: string, venueId: string, photoId: string, hash: string) =>
  `${origin}${PREPARED_ASSET_PATH}/${venueId}/${photoId}/${hash}`;

/** Width and height from a PNG or baseline/progressive JPEG header; null when unreadable. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    String.fromCharCode(...bytes.subarray(12, 16)) === 'IHDR'
  ) {
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    return width > 0 && height > 0 && width <= 16_384 && height <= 16_384
      ? { width, height }
      : null;
  }
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    const length = view.getUint16(offset + 2);
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      const height = view.getUint16(offset + 5);
      const width = view.getUint16(offset + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

function cleanIngredients(values: readonly string[] | null): string[] | null {
  if (!values || values.length === 0 || values.length > 100) return null;
  const names = values.map((name) => (typeof name === 'string' ? name.trim() : ''));
  return names.every((name) => name.length > 0 && name.length <= 160 && !name.includes('\u0000'))
    ? names
    : null;
}

/**
 * Builds the bundle for one venue's verified dishes. Pure: the same dishes produce the same
 * bytes, revision id and hashes, so a repeated preparation is an identical, idempotent retry.
 */
export async function buildPreparedBundle(input: {
  venueId: string;
  restaurantName: string;
  origin: string;
  dishes: readonly VerifiedDish[];
}): Promise<PreparedBundle> {
  const menuId = await ownerMenuId(input.venueId);
  const diagnostics: PrepareDiagnostic[] = [];
  const assets: unknown[] = [];
  const byCategory = new Map<string, PublicMenuDish[]>();
  let completeDishes = 0;

  for (const dish of input.dishes) {
    const dishId = await derivedUuid('owner-prepared-dish:v1', input.venueId, dish.draftId);
    const dishRevisionId = await derivedUuid(
      'owner-prepared-dish-revision:v1',
      input.venueId,
      dish.draftId,
      String(dish.draftVersion),
      dish.photo?.sha256 ?? '',
    );
    const gaps: PrepareDiagnostic['code'][] = [];
    const category = dish.category?.trim() || null;
    if (!category) gaps.push('category_missing');
    const description = dish.description?.trim() ?? '';
    if (!description || description.length > 4000 || description.includes('\u0000'))
      gaps.push('description_missing');
    const price = normalizePrice(dish.priceAmount);
    if (!price.ok) gaps.push(price.reason);
    const currency =
      dish.priceCurrency && /^[A-Z]{3}$/.test(dish.priceCurrency) ? dish.priceCurrency : null;
    if (!currency) gaps.push('currency_missing');
    const ingredients = cleanIngredients(dish.ingredients);
    if (!ingredients) gaps.push('ingredients_missing');
    if (!dish.photo) gaps.push('photo_missing');
    diagnostics.push(...gaps.map((code) => ({ draftId: dish.draftId, code })));

    const name = dish.name.trim();
    const list = byCategory.get(category ?? 'Menu') ?? [];
    if (gaps.length > 0 || !price.ok || !currency || !ingredients || !dish.photo) {
      list.push({ dish_id: dishId, dish_revision_id: dishRevisionId, complete: false });
    } else {
      const url = assetUrl(input.origin, input.venueId, dish.photo.id, dish.photo.sha256);
      const image = {
        url,
        width: dish.photo.width,
        height: dish.photo.height,
        alt: `Photo of ${name}`.slice(0, 500),
      };
      const allergens =
        dish.allergens === null
          ? null
          : [
              ...new Set(
                dish.allergens.filter(
                  (code) => PublicMenuAllergenCodeSchema.safeParse(code).success,
                ),
              ),
            ];
      list.push({
        dish_id: dishId,
        dish_revision_id: dishRevisionId,
        complete: true,
        name,
        description,
        price: { amount: price.amount, currency },
        ingredients: await Promise.all(
          ingredients.map(async (ingredient, index) => ({
            ingredient_id: await derivedUuid(
              'ingredient:v1',
              dishRevisionId,
              String(index),
              ingredient,
            ),
            name: ingredient,
            description: null,
          })),
        ),
        allergens,
        dietary: [],
        images: { card: image, detail: image },
      });
      assets.push({
        dish_id: dishId,
        dish_revision_id: dishRevisionId,
        asset_id: dish.photo.id,
        card: {
          url,
          digest: dish.photo.sha256,
          width: dish.photo.width,
          height: dish.photo.height,
        },
        detail: {
          url,
          digest: dish.photo.sha256,
          width: dish.photo.width,
          height: dish.photo.height,
        },
      });
      completeDishes += 1;
    }
    byCategory.set(category ?? 'Menu', list);
  }

  const categories = await Promise.all(
    [...byCategory.entries()].map(async ([name, dishes]) => ({
      category_id: await derivedUuid('owner-prepared-category:v1', input.venueId, name),
      name,
      dishes,
    })),
  );
  (assets as { dish_id: string }[]).sort((a, b) => (a.dish_id < b.dish_id ? -1 : 1));
  const assetManifestHash = await sha256(canonicalJson({ schema_version: 1, assets }));
  const pending = parse({
    schema_version: 1,
    venue_id: input.venueId,
    menu_id: menuId,
    menu_revision_id: PENDING_REVISION_ID,
    restaurant: { name: input.restaurantName.trim().slice(0, 160), logo: null },
    categories,
  });
  const { menu_revision_id: _pending, ...withoutRevision } = pending;
  const menuRevisionId = await derivedUuid('menu-revision:v1', canonicalJson(withoutRevision));
  const bundle = parse({ ...pending, menu_revision_id: menuRevisionId });
  const bytes = new TextEncoder().encode(canonicalJson(bundle));
  const contentHash = await sha256(bytes);
  await verifyPublicMenuContentBytes(bytes, contentHash);
  return {
    bundle,
    bytes,
    contentHash,
    assetManifestHash,
    menuId,
    menuRevisionId,
    contentApprovalId: await derivedUuid('content-approval:v1', contentHash),
    assetApprovalId: await derivedUuid('asset-approval:v1', assetManifestHash),
    bundleUrl: `${input.origin}${PREPARED_BUNDLE_PATH}/${input.venueId}/${menuId}/${menuRevisionId}.json`,
    completeDishes,
    diagnostics,
  };
}

function parse(value: unknown): PublicMenuContentBundle {
  const parsed = PublicMenuContentBundleSchema.safeParse(value);
  if (!parsed.success) throw new IngestionError('invalid_prepared_menu', 422);
  return parsed.data;
}

type DraftRow = {
  id: string;
  draft_version: number;
  origin: string | null;
  name: string | null;
  description: string | null;
  category: string | null;
  price_amount: string | null;
  price_currency: string | null;
  ingredients: unknown;
  manual_fields: Record<string, unknown> | null;
  corrected_fields: Record<string, unknown> | null;
  photo_id: string | null;
  photo_hash: string | null;
  photo_key: string | null;
};

const stringOrNull = (value: unknown) => (typeof value === 'string' ? value : null);
const confirmed = (value: unknown): unknown[] | null => {
  const items = value as { status?: unknown; items?: unknown } | null;
  return items?.status === 'confirmed' && Array.isArray(items.items) ? items.items : null;
};

/**
 * Reads the verified, active drafts of one venue and the owner-approved photo of each, under
 * the owner's authorization. Rejected candidates, removed or unverified drafts are excluded.
 */
export async function loadVerifiedDishes(
  client: Client,
  actorId: string,
  venueId: string,
  storage: PreparedStorage,
): Promise<{ restaurantName: string; dishes: VerifiedDish[] }> {
  await beginAuthorizedOwner(client, actorId, venueId);
  let rows: DraftRow[];
  let restaurantName: string;
  try {
    const venue = await client.query<{ name: string }>(
      `SELECT COALESCE(p.fields->>'name', v.name) AS name
         FROM app_private.venues v
         LEFT JOIN app_private.restaurant_profile p ON p.tenant_id = v.id
        WHERE v.id = $1`,
      [venueId],
    );
    restaurantName = venue.rows[0]?.name ?? '';
    const result = await client.query<DraftRow>(
      `SELECT d.id, d.draft_version, d.origin, d.name, d.description, d.category,
              d.price_amount::text AS price_amount, d.price_currency, d.ingredients, d.manual_fields,
              c.corrected_fields, ph.id AS photo_id, ph.source_hash AS photo_hash,
              ph.storage_key AS photo_key
         FROM app_private.dish_drafts d
         LEFT JOIN app_private.extraction_review_session s
           ON s.tenant_id = d.tenant_id AND s.job_id = d.job_id
         LEFT JOIN app_private.candidate_review_current c
           ON c.tenant_id = s.tenant_id AND c.extraction_id = s.extraction_id
          AND c.candidate_id = d.candidate_id
         LEFT JOIN LATERAL (
           SELECT p.id, p.source_hash, p.storage_key
             FROM app_private.dish_draft_photo p
            WHERE p.tenant_id = d.tenant_id AND p.draft_id = d.id
              AND p.verification_status = 'verified'
              AND p.storage_key = 'menu-assets/' || d.tenant_id || '/' || p.id || '/' || p.source_hash
            ORDER BY (p.id::text = d.manual_fields->>'photoId') DESC, p.updated_at DESC
            LIMIT 1
         ) ph ON true
        WHERE d.tenant_id = $1 AND d.verification_status = 'verified'
          AND d.review_status = 'pending' AND d.removed_at IS NULL
          AND (c.review_status IS NULL OR c.review_status <> 'rejected')
        ORDER BY d.category NULLS LAST, d.draft_index, d.id
        LIMIT 501`,
      [venueId],
    );
    if (result.rows.length > 500) throw new IngestionError('too_many_dishes', 422);
    rows = result.rows;
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }

  const dishes: VerifiedDish[] = [];
  for (const row of rows) {
    const corrected = row.corrected_fields ?? {};
    const manual = row.manual_fields ?? null;
    const pick = (key: string, fallback: string | null) =>
      key in corrected ? stringOrNull(corrected[key]) : fallback;
    const rowIngredients = Array.isArray(row.ingredients) ? (row.ingredients as string[]) : null;
    let ingredients: readonly string[] | null =
      'ingredients' in corrected && Array.isArray(corrected.ingredients)
        ? (corrected.ingredients as string[])
        : rowIngredients;
    // An owner-entered list only becomes a public fact once confirmed (ApprovedDishFacts rule).
    if (manual && 'ingredients' in manual)
      ingredients = (confirmed(manual.ingredients) as string[] | null) ?? null;
    const allergenItems = manual ? confirmed(manual.allergens) : null;
    let photo: VerifiedDish['photo'] = null;
    if (row.photo_id && row.photo_hash && row.photo_key) {
      const object = await storage.get(row.photo_key);
      const buffer = object ? await object.arrayBuffer() : null;
      const bytes = buffer && buffer.byteLength <= MAX_PHOTO_BYTES ? new Uint8Array(buffer) : null;
      // The stored bytes must still be the approved photo before diners are pointed at them.
      if (bytes && (await sha256(bytes)) === row.photo_hash) {
        const size = imageSize(bytes);
        if (size) photo = { id: row.photo_id, sha256: row.photo_hash, ...size };
      }
    }
    dishes.push({
      draftId: row.id,
      draftVersion: row.draft_version,
      name: pick('name', row.name) ?? '',
      description: pick('description', row.description),
      category: pick('category', row.category),
      priceAmount: pick('price_amount', row.price_amount),
      priceCurrency: pick('price_currency', row.price_currency),
      ingredients,
      allergens: allergenItems as PublicMenuAllergenCode[] | null,
      photo,
    });
  }
  return { restaurantName, dishes: dishes.filter((dish) => dish.name.trim().length > 0) };
}

/**
 * Prepares (or re-prepares) the owner's menu: build, store immutable bytes, admit. A repeated
 * call with unchanged dishes returns the same revision without writing anything new.
 */
export async function prepareOwnerMenu(
  client: Client,
  actorId: string,
  venueId: string,
  origin: string,
  storage: PreparedStorage,
): Promise<{
  menuId: string;
  menuRevisionId: string;
  completeDishes: number;
  diagnostics: PrepareDiagnostic[];
  status: 'inserted' | 'already_present';
}> {
  const { restaurantName, dishes } = await loadVerifiedDishes(client, actorId, venueId, storage);
  if (!restaurantName.trim()) throw new IngestionError('restaurant_name_missing', 409);
  const prepared = await buildPreparedBundle({ venueId, restaurantName, origin, dishes });
  if (prepared.completeDishes === 0) throw new IngestionError('nothing_to_prepare', 409);

  const key = bundleKey(venueId, prepared.menuId, prepared.menuRevisionId);
  const body = Uint8Array.from(prepared.bytes).buffer;
  const put = await storage.put(key, body, {
    onlyIf: { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: 'application/json' },
  });
  if (put === null) {
    // Already stored: the bytes for a revision id can never differ (the id derives from them).
    const existing = await storage.get(key);
    const stored = existing ? new Uint8Array(await existing.arrayBuffer()) : null;
    if (!stored || (await sha256(stored)) !== prepared.contentHash)
      throw new IngestionError('prepared_bundle_conflict', 409);
  }

  await beginAuthorizedOwner(client, actorId, venueId);
  let status: 'inserted' | 'already_present';
  try {
    const result = await client.query<{ status: 'inserted' | 'already_present' }>(
      'SELECT app_private.admit_owner_prepared_menu($1,$2,$3,$4,$5,$6,$7) AS status',
      [
        prepared.menuId,
        prepared.menuRevisionId,
        prepared.contentApprovalId,
        prepared.contentHash,
        prepared.assetApprovalId,
        prepared.assetManifestHash,
        prepared.bundleUrl,
      ],
    );
    status = result.rows[0]!.status;
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
  return {
    menuId: prepared.menuId,
    menuRevisionId: prepared.menuRevisionId,
    completeDishes: prepared.completeDishes,
    diagnostics: prepared.diagnostics,
    status,
  };
}

/** Public: the stored bundle bytes, only for an admitted revision of this venue. */
export async function readPreparedBundle(
  client: Client,
  storage: PreparedStorage,
  venueId: string,
  menuId: string,
  revisionId: string,
): Promise<Uint8Array | null> {
  await client.query('BEGIN READ ONLY');
  let admitted = false;
  try {
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [venueId]);
    const found = await client.query(
      `SELECT 1 FROM app_private.public_menu_bundle
        WHERE tenant_id = $1 AND menu_id = $2 AND menu_revision_id = $3
          AND bundle_url LIKE '%' || $4`,
      [
        venueId,
        menuId,
        revisionId,
        `${PREPARED_BUNDLE_PATH}/${venueId}/${menuId}/${revisionId}.json`,
      ],
    );
    admitted = (found.rowCount ?? 0) > 0;
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
  if (!admitted) return null;
  const object = await storage.get(bundleKey(venueId, menuId, revisionId));
  return object ? new Uint8Array(await object.arrayBuffer()) : null;
}

/** Public: an owner-approved dish photo at its immutable, hash-named address. */
export async function readPreparedAsset(
  client: Client,
  storage: PreparedStorage,
  venueId: string,
  photoId: string,
  hash: string,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const key = `menu-assets/${venueId}/${photoId}/${hash}`;
  await client.query('BEGIN READ ONLY');
  let contentType: string | null = null;
  try {
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [venueId]);
    const found = await client.query<{ content_type: string }>(
      `SELECT content_type FROM app_private.dish_draft_photo
        WHERE tenant_id = $1 AND id = $2 AND source_hash = $3
          AND verification_status = 'verified' AND storage_key = $4`,
      [venueId, photoId, hash, key],
    );
    contentType = found.rows[0]?.content_type ?? null;
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
  if (!contentType) return null;
  const object = await storage.get(key);
  if (!object) return null;
  const bytes = new Uint8Array(await object.arrayBuffer());
  return (await sha256(bytes)) === hash ? { bytes, contentType } : null;
}
