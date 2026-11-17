// Automatic menu preparation (Part A). After an owner verifies their dishes (S10/S11, which stays
// verification-only), "Review and publish" runs this. It reuses the existing pieces end to end:
//
// 1. Each verified, still-pending draft is approved through the existing approval command
//    (approveDishDraftAtomic) with the owner's persisted verification and the exact draft/review
//    versions. That command snapshots the approved facts (category, price, ingredients, confirmed
//    allergens, serving count, selected photo) onto a canonical dish revision.
// 2. The existing producer reads those canonical revisions (loadApprovedDishSources) and builds
//    the bundle (produceMenuBundle), with owner-approved photos bound to each revision and the
//    agreed text-only fallback for dishes without a photo.
// 3. The restaurant name and logo come from the saved Screen 5 profile, with the same public
//    descriptor, hash and dimension rules as the operator exporter.
// 4. The immutable bytes are stored and admitted for S13 through one owner-scoped function.
//
// Nothing here publishes: S13 still needs the owner's explicit approval and publication. A failed
// or partial run is safe to repeat: approvals use deterministic command IDs and a stable dish ID
// per draft, and already-approved dishes are included again on the next run.
import { sha256 } from '@peekaplate/contracts';
import type { Client } from 'pg';
import { derivedUuid } from './bundle-producer/ids';
import { logoDimensions } from './bundle-producer/logo-image';
import {
  type ApprovedDishSource,
  type BundleDiagnostic,
  BundleProducerError,
  type OwnerApprovedPhoto,
  produceMenuBundle,
} from './bundle-producer/produce';
import { loadApprovedDishSources } from './bundle-producer/repository';
import { type MenuBundleRequest, MenuBundleRequestSchema } from './bundle-producer/request';
import { IngestionError } from './ingestion/repository';
import { beginAuthorizedOwner } from './publication-command';

export const PREPARED_BUNDLE_PATH = '/public/prepared-bundles';
export const PREPARED_ASSET_PATH = '/public/prepared-assets';
const MAX_IMAGE_BYTES = 12_000_000;
const MAX_DISHES = 500;

export type PreparedStorage = {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  put(
    key: string,
    bytes: ArrayBuffer,
    options?: { onlyIf?: { etagDoesNotMatch?: string }; httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
};

/** The existing approval command (approveDishDraftAtomic), injected to avoid an import cycle. */
export type ApproveDraft = (
  client: Client,
  actorId: string,
  venueId: string,
  draftId: string,
  options: {
    commandId: string;
    expectedVersion: number;
    expectedDraftVersion: number;
    expectedReviewVersion?: number;
    extractionId?: string;
    confirmed: true;
    preparedDishId: string;
  },
) => Promise<unknown>;

export const ownerMenuId = (venueId: string) => derivedUuid('owner-prepared-menu:v1', venueId);
/** Stable canonical dish per owner draft: a reopened, re-verified draft keeps its diner identity. */
export const preparedDishId = (venueId: string, draftId: string) =>
  derivedUuid('owner-prepared-dish:v1', venueId, draftId);
export const bundleKey = (venueId: string, menuId: string, revisionId: string) =>
  `prepared-menus/${venueId}/${menuId}/${revisionId}.json`;
export const assetUrl = (origin: string, venueId: string, photoId: string, hash: string) =>
  `${origin}${PREPARED_ASSET_PATH}/${venueId}/${photoId}/${hash}`;
export const logoUrl = (origin: string, venueId: string, hash: string, extension: string) =>
  `${origin}${PREPARED_ASSET_PATH}/${venueId}/logo/${hash}.${extension}`;

async function inOwnerRead<T>(
  client: Client,
  actorId: string,
  venueId: string,
  work: () => Promise<T>,
): Promise<T> {
  await beginAuthorizedOwner(client, actorId, venueId);
  try {
    const result = await work();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function readHashedObject(
  storage: PreparedStorage,
  key: string,
  hash: string,
): Promise<Uint8Array | null> {
  const object = await storage.get(key);
  const buffer = object ? await object.arrayBuffer() : null;
  if (!buffer || buffer.byteLength > MAX_IMAGE_BYTES) return null;
  const bytes = new Uint8Array(buffer);
  return (await sha256(bytes)) === hash ? bytes : null;
}

function imageDimensions(bytes: Uint8Array, contentType: string) {
  try {
    return logoDimensions(bytes, contentType);
  } catch {
    return null;
  }
}

type DraftRow = {
  id: string;
  draft_version: number;
  review_status: 'pending' | 'accepted';
  published_dish_id: string | null;
  verification_status: string;
  extraction_id: string | null;
  review_version: number | null;
  has_session: boolean;
};

/** The canonical Screen 5 profile: public name and exact logo bytes only. */
async function readOwnerRestaurant(
  client: Client,
  venueId: string,
  origin: string,
  storage: PreparedStorage,
): Promise<MenuBundleRequest['restaurant']> {
  const profile = await client.query<{
    name: string | null;
    venue_name: string;
    storage_key: string | null;
    content_type: string | null;
    source_hash: string | null;
  }>(
    `SELECT p.fields->>'name' AS name, v.name AS venue_name,
            ph.storage_key, ph.content_type, ph.source_hash
       FROM app_private.venues v
       LEFT JOIN app_private.restaurant_profile p ON p.tenant_id = v.id
       LEFT JOIN app_private.restaurant_profile_photo ph
         ON ph.tenant_id = v.id AND ph.id::text = p.fields->>'photoId'
      WHERE v.id = $1`,
    [venueId],
  );
  const row = profile.rows[0];
  const name = (row?.name ?? row?.venue_name ?? '').trim();
  if (!name) throw new IngestionError('restaurant_name_missing', 409);
  if (!row?.storage_key || !row.source_hash || !row.content_type) return { name, logo: null };
  const bytes = await readHashedObject(storage, row.storage_key, row.source_hash);
  const size = bytes ? imageDimensions(bytes, row.content_type) : null;
  // A selected logo whose stored bytes are missing or changed is never silently dropped.
  if (!size) throw new IngestionError('restaurant_logo_unavailable', 409);
  return {
    name,
    logo: {
      url: logoUrl(origin, venueId, row.source_hash, size.extension),
      width: size.width,
      height: size.height,
      alt: `${name} logo`.slice(0, 500),
    },
  };
}

/** The owner-selected photo of each approved revision, hash-checked against storage. */
async function readOwnerPhotos(
  client: Client,
  venueId: string,
  origin: string,
  storage: PreparedStorage,
  sources: ReadonlyMap<string, ApprovedDishSource>,
): Promise<Map<string, OwnerApprovedPhoto>> {
  const wanted = [...sources.values()].filter((source) => source.approvedPhotoId);
  if (wanted.length === 0) return new Map();
  const rows = await client.query<{
    dish_id: string;
    id: string;
    source_hash: string;
    storage_key: string;
    content_type: string;
  }>(
    `SELECT d.published_dish_id AS dish_id, p.id, p.source_hash, p.storage_key, p.content_type
       FROM app_private.dish_drafts d
       JOIN app_private.dish_draft_photo p ON p.tenant_id = d.tenant_id AND p.draft_id = d.id
      WHERE d.tenant_id = $1 AND d.published_dish_id = ANY($2::uuid[])
        AND d.review_status = 'accepted' AND d.removed_at IS NULL
        AND p.id = ANY($3::uuid[]) AND p.verification_status = 'verified'
        AND p.storage_key = 'menu-assets/' || d.tenant_id || '/' || p.id || '/' || p.source_hash`,
    [
      venueId,
      wanted.map((source) => source.dishId),
      wanted.map((source) => source.approvedPhotoId),
    ],
  );
  const photos = new Map<string, OwnerApprovedPhoto>();
  for (const row of rows.rows) {
    const source = sources.get(row.dish_id);
    // Only the photo the owner selected on this exact revision (tenant- and draft-bound above).
    if (!source || source.approvedPhotoId !== row.id) continue;
    const bytes = await readHashedObject(storage, row.storage_key, row.source_hash);
    const size = bytes ? imageDimensions(bytes, row.content_type) : null;
    // Missing or changed bytes fall back to the agreed text-only dish, never another photo.
    if (!size) continue;
    photos.set(source.dishId, {
      dishId: source.dishId,
      dishRevisionId: source.dishRevisionId,
      photoId: row.id,
      url: assetUrl(origin, venueId, row.id, row.source_hash),
      sha256: row.source_hash,
      width: size.width,
      height: size.height,
    });
  }
  return photos;
}

export type PrepareResult = {
  menuId: string;
  menuRevisionId: string;
  completeDishes: number;
  diagnostics: BundleDiagnostic[];
  status: 'inserted' | 'already_present';
};

/**
 * Prepares (or re-prepares) the owner's menu. Safe to repeat after any failure: approvals are
 * idempotent per draft version, approved dishes are always included, and unchanged dishes give
 * the same revision without writing anything new.
 */
export async function prepareOwnerMenu(
  client: Client,
  actorId: string,
  venueId: string,
  origin: string,
  storage: PreparedStorage,
  approve: ApproveDraft,
): Promise<PrepareResult> {
  const menuId = await ownerMenuId(venueId);
  const readDrafts = () =>
    inOwnerRead(client, actorId, venueId, async () => {
      const result = await client.query<DraftRow>(
        `SELECT d.id, d.draft_version, d.review_status, d.published_dish_id, d.verification_status,
                j.active_review_extraction_id AS extraction_id, c.version AS review_version,
                EXISTS(SELECT 1 FROM app_private.extraction_review_session s
                        WHERE s.tenant_id = d.tenant_id AND s.job_id = d.job_id) AS has_session
           FROM app_private.dish_drafts d
           LEFT JOIN app_private.menu_ingestion_jobs j ON j.tenant_id = d.tenant_id AND j.id = d.job_id
           LEFT JOIN app_private.candidate_review_current c
             ON c.tenant_id = d.tenant_id AND c.extraction_id = j.active_review_extraction_id
            AND c.candidate_id = COALESCE(d.candidate_id, d.draft_id)
          WHERE d.tenant_id = $1 AND d.removed_at IS NULL
            AND d.review_status IN ('pending', 'accepted')
            AND (c.review_status IS NULL OR c.review_status <> 'rejected')
          ORDER BY d.category NULLS LAST, d.draft_index, d.id
          LIMIT ${MAX_DISHES + 1}`,
        [venueId],
      );
      if (result.rows.length > MAX_DISHES) throw new IngestionError('too_many_dishes', 422);
      return result.rows;
    });

  // 1. Approve every verified, still-pending draft through the existing approval command, with
  //    the owner's persisted verification and the exact draft/review versions.
  const diagnostics: BundleDiagnostic[] = [];
  const drafts = await readDrafts();
  if (drafts.some((draft) => draft.verification_status !== 'verified'))
    throw new IngestionError('menu_not_verified', 409);
  for (const draft of drafts.filter((row) => row.review_status === 'pending')) {
    const dishId = await preparedDishId(venueId, draft.id);
    const current = await inOwnerRead(client, actorId, venueId, async () => {
      const found = await client.query<{ version: number }>(
        'SELECT version FROM app_private.dish_current WHERE tenant_id = $1 AND dish_id = $2',
        [venueId, dishId],
      );
      return found.rows[0]?.version ?? 0;
    });
    const reviewVersion = draft.has_session ? (draft.review_version ?? 0) : undefined;
    try {
      await approve(client, actorId, venueId, draft.id, {
        commandId: await derivedUuid(
          'owner-prepare-approval:v1',
          venueId,
          draft.id,
          String(draft.draft_version),
          String(reviewVersion ?? ''),
          String(current),
        ),
        expectedVersion: current,
        expectedDraftVersion: draft.draft_version,
        ...(reviewVersion === undefined ? {} : { expectedReviewVersion: reviewVersion }),
        ...(draft.has_session && draft.extraction_id ? { extractionId: draft.extraction_id } : {}),
        confirmed: true,
        preparedDishId: dishId,
      });
    } catch (error) {
      // A verified dish that cannot become a public fact stays out and is reported; any other
      // failure stops here and the next run continues from the dishes already approved.
      if (error instanceof IngestionError && error.code === 'draft_incomplete') {
        diagnostics.push({ dishId, code: 'review_incomplete' });
        continue;
      }
      throw error;
    }
  }

  // 2. Every approved, verified dish of the venue, in menu order, from its canonical revision.
  const approved = (await readDrafts()).filter(
    (draft): draft is DraftRow & { published_dish_id: string } =>
      draft.review_status === 'accepted' &&
      draft.verification_status === 'verified' &&
      draft.published_dish_id !== null,
  );
  if (approved.length === 0) throw new IngestionError('nothing_to_prepare', 409);
  const sources = await loadApprovedDishSources(
    client,
    venueId,
    approved.map((draft) => draft.published_dish_id),
  );
  const { restaurant, photos } = await inOwnerRead(client, actorId, venueId, async () => ({
    restaurant: await readOwnerRestaurant(client, venueId, origin, storage),
    photos: await readOwnerPhotos(client, venueId, origin, storage, sources),
  }));

  const byCategory = new Map<string, MenuBundleRequest['categories'][number]['dishes']>();
  for (const draft of approved) {
    const source = sources.get(draft.published_dish_id);
    if (!source) continue;
    const category = source.approvedCategory ?? 'Menu';
    const list = byCategory.get(category) ?? [];
    list.push({
      dish_id: source.dishId,
      allergens: null,
      dietary: [],
      image_alt: `Photo of ${source.name.trim()}`.slice(0, 500),
      t0_asset_id: null,
    });
    byCategory.set(category, list);
  }
  const request = MenuBundleRequestSchema.safeParse({
    schema_version: 1,
    venue_id: venueId,
    menu_id: menuId,
    restaurant,
    bundle_base_url: `${origin}${PREPARED_BUNDLE_PATH}`,
    asset_base_url: `${origin}${PREPARED_ASSET_PATH}`,
    categories: await Promise.all(
      [...byCategory.entries()].map(async ([name, dishes]) => ({
        category_id: await derivedUuid('owner-prepared-category:v1', venueId, name),
        name,
        dishes,
      })),
    ),
  });
  if (!request.success) throw new IngestionError('invalid_prepared_menu', 422);

  // 3. The existing producer: same bytes, IDs, hashes and completeness rules as the operator path.
  let produced: Awaited<ReturnType<typeof produceMenuBundle>>;
  try {
    produced = await produceMenuBundle(request.data, sources, new Map(), {
      ownerPhotos: photos,
      missingPhoto: 'text_only',
    });
  } catch (error) {
    if (error instanceof BundleProducerError)
      throw new IngestionError('invalid_prepared_menu', 422);
    throw error;
  }
  const completeDishes = produced.bundle.categories
    .flatMap((category) => category.dishes)
    .filter((dish) => dish.complete).length;
  if (completeDishes === 0) throw new IngestionError('nothing_to_prepare', 409);

  // 4. Store the immutable bytes, then admit them for S13.
  const key = bundleKey(venueId, menuId, produced.menuRevisionId);
  const put = await storage.put(key, Uint8Array.from(produced.bytes).buffer, {
    onlyIf: { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: 'application/json' },
  });
  if (put === null) {
    // Already stored: the bytes for a revision ID never differ (the ID derives from them).
    const existing = await storage.get(key);
    const stored = existing ? new Uint8Array(await existing.arrayBuffer()) : null;
    if (!stored || (await sha256(stored)) !== produced.contentHash)
      throw new IngestionError('prepared_bundle_conflict', 409);
  }
  const status = await inOwnerRead(client, actorId, venueId, async () => {
    const result = await client.query<{ status: 'inserted' | 'already_present' }>(
      'SELECT app_private.admit_owner_prepared_menu($1,$2,$3,$4,$5,$6,$7) AS status',
      [
        menuId,
        produced.menuRevisionId,
        produced.contentApprovalId,
        produced.contentHash,
        produced.assetApprovalId,
        produced.assetManifestHash,
        produced.bundleUrl,
      ],
    );
    return result.rows[0]!.status;
  });
  return {
    menuId,
    menuRevisionId: produced.menuRevisionId,
    completeDishes,
    diagnostics: [...diagnostics, ...produced.diagnostics],
    status,
  };
}

async function inPublicRead<T>(client: Client, venueId: string, work: () => Promise<T>) {
  await client.query('BEGIN READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [venueId]);
    const result = await work();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

/** Public: the stored bundle bytes, only for an admitted revision of this venue. */
export async function readPreparedBundle(
  client: Client,
  storage: PreparedStorage,
  venueId: string,
  menuId: string,
  revisionId: string,
): Promise<Uint8Array | null> {
  const admitted = await inPublicRead(client, venueId, async () => {
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
    return (found.rowCount ?? 0) > 0;
  });
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
  const contentType = await inPublicRead(client, venueId, async () => {
    const found = await client.query<{ content_type: string }>(
      `SELECT content_type FROM app_private.dish_draft_photo
        WHERE tenant_id = $1 AND id = $2 AND source_hash = $3
          AND verification_status = 'verified' AND storage_key = $4`,
      [venueId, photoId, hash, key],
    );
    return found.rows[0]?.content_type ?? null;
  });
  if (!contentType) return null;
  const bytes = await readHashedObject(storage, key, hash);
  return bytes ? { bytes, contentType } : null;
}

/**
 * Public: a Screen 5 logo, only once the venue has an admitted prepared menu (whose bundle
 * carries the logo URL), and only bytes that still match the hash and type in that URL.
 */
export async function readPreparedLogo(
  client: Client,
  storage: PreparedStorage,
  venueId: string,
  hash: string,
  extension: string,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const row = await inPublicRead(client, venueId, async () => {
    const admitted = await client.query(
      `SELECT 1 FROM app_private.public_menu_bundle
        WHERE tenant_id = $1 AND bundle_url LIKE '%' || $2 LIMIT 1`,
      [venueId, `${PREPARED_BUNDLE_PATH}/${venueId}/%`],
    );
    if ((admitted.rowCount ?? 0) === 0) return null;
    const found = await client.query<{ storage_key: string; content_type: string }>(
      `SELECT storage_key, content_type FROM app_private.restaurant_profile_photo
        WHERE tenant_id = $1 AND source_hash = $2`,
      [venueId, hash],
    );
    return found.rows[0] ?? null;
  });
  if (!row) return null;
  if (extension !== (row.content_type === 'image/png' ? 'png' : 'jpg')) return null;
  const bytes = await readHashedObject(storage, row.storage_key, hash);
  return bytes && imageDimensions(bytes, row.content_type)
    ? { bytes, contentType: row.content_type }
    : null;
}
