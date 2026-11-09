import {
  canonicalJson,
  type PublicMenuContentBundle,
  PublicMenuContentBundleSchema,
  type PublicMenuDish,
  sha256,
  verifyPublicMenuContentBytes,
} from '@peekaplate/contracts';
import { derivedUuid } from './ids';
import { normalizePrice } from './price';
import {
  type MenuBundleRequest,
  type MenuBundleRequestDish,
  MenuBundleRequestSchema,
  type T0AssetManifest,
  webpVariant,
} from './request';

/** Approved facts for one dish, already resolved from `dish_current`, drafts and RES-01.2. */
export type ApprovedDishSource = {
  dishId: string;
  dishRevisionId: string;
  name: string;
  description: string;
  priceAmount: string | null;
  priceCurrency: string | null;
  ingredients: unknown;
  reviewState: 'none' | 'corrected' | 'incomplete' | 'rejected';
};

/** A PR #25 T0 manifest whose webp variant files the caller has already hash-checked. */
export type VerifiedT0Asset = { manifest: T0AssetManifest };

export type BundleDiagnosticCode =
  | 'candidate_rejected'
  | 'review_incomplete'
  | 'description_missing'
  | 'price_missing'
  | 'price_not_representable'
  | 'currency_missing'
  | 'ingredients_missing'
  | 'alt_missing'
  | 'asset_missing'
  | 'asset_revision_mismatch';

export type BundleDiagnostic = { dishId: string; code: BundleDiagnosticCode };

export type ProducedMenuBundle = {
  bundle: PublicMenuContentBundle;
  bytes: Uint8Array;
  contentHash: string;
  assetManifestHash: string;
  menuRevisionId: string;
  contentApprovalId: string;
  assetApprovalId: string;
  bundleUrl: string;
  diagnostics: BundleDiagnostic[];
};

export type BundleProducerErrorCode =
  | 'invalid_request'
  | 'dish_not_found'
  | 'asset_dish_mismatch'
  | 'invalid_bundle'
  | 'ambiguous_dish_source'
  | 'ambiguous_candidate_review'
  | 'handoff_conflict';

export class BundleProducerError extends Error {
  readonly code: BundleProducerErrorCode;

  constructor(code: BundleProducerErrorCode, message: string) {
    super(message);
    this.name = 'BundleProducerError';
    this.code = code;
  }
}

type AssetManifestEntry = {
  dish_id: string;
  dish_revision_id: string;
  asset_id: string;
  card: { url: string; sha256: string; width: number; height: number };
  detail: { url: string; sha256: string; width: number; height: number };
};

// Placeholder used only while computing the revision ID; it never reaches the output.
const PENDING_REVISION_ID = '00000000-0000-4000-8000-000000000000';

/**
 * Builds a Bundle v1 from approved sources. Pure and deterministic: no clock, randomness or I/O.
 * Dishes missing any required approved fact become identity-only placeholders and are reported
 * in `diagnostics` (never in the bundle). Structural problems throw `BundleProducerError`.
 */
export async function produceMenuBundle(
  request: MenuBundleRequest,
  dishes: ReadonlyMap<string, ApprovedDishSource>,
  assets: ReadonlyMap<string, VerifiedT0Asset>,
): Promise<ProducedMenuBundle> {
  const parsedRequest = MenuBundleRequestSchema.safeParse(request);
  if (!parsedRequest.success) {
    throw new BundleProducerError('invalid_request', 'Bundle request does not match schema v1');
  }
  const input = parsedRequest.data;
  const diagnostics: BundleDiagnostic[] = [];
  const assetEntries: AssetManifestEntry[] = [];

  const categories = [];
  for (const category of input.categories) {
    const categoryDishes: PublicMenuDish[] = [];
    for (const requested of category.dishes) {
      const source = dishes.get(requested.dish_id);
      if (!source) {
        throw new BundleProducerError(
          'dish_not_found',
          `Dish ${requested.dish_id} has no approved revision for this venue`,
        );
      }
      if (source.reviewState === 'rejected') {
        diagnostics.push({ dishId: requested.dish_id, code: 'candidate_rejected' });
        continue;
      }
      const built = await buildDish(input, requested, source, assets);
      diagnostics.push(...built.gaps.map((code) => ({ dishId: requested.dish_id, code })));
      categoryDishes.push(built.dish);
      if (built.asset) assetEntries.push(built.asset);
    }
    categories.push({
      category_id: category.category_id,
      name: category.name,
      dishes: categoryDishes,
    });
  }

  assetEntries.sort((left, right) => (left.dish_id < right.dish_id ? -1 : 1));
  const assetManifestHash = await sha256(
    canonicalJson({ schema_version: 1, assets: assetEntries }),
  );

  const pending = parseBundle({
    schema_version: 1,
    venue_id: input.venue_id,
    menu_id: input.menu_id,
    menu_revision_id: PENDING_REVISION_ID,
    restaurant: input.restaurant,
    categories,
  });
  const { menu_revision_id: _pending, ...withoutRevision } = pending;
  // The asset manifest hash is part of the revision so that re-encoded variants behind
  // unchanged URLs still produce a new reviewable subject instead of a handoff conflict.
  const menuRevisionId = await derivedUuid(
    'menu-revision:v1',
    canonicalJson(withoutRevision),
    assetManifestHash,
  );
  const bundle = parseBundle({ ...pending, menu_revision_id: menuRevisionId });
  const bytes = new TextEncoder().encode(canonicalJson(bundle));
  const contentHash = await sha256(bytes);
  await verifyPublicMenuContentBytes(bytes, contentHash);

  return {
    bundle,
    bytes,
    contentHash,
    assetManifestHash,
    menuRevisionId,
    contentApprovalId: await derivedUuid('content-approval:v1', contentHash),
    assetApprovalId: await derivedUuid('asset-approval:v1', assetManifestHash),
    bundleUrl: `${input.bundle_base_url}/${input.venue_id}/${input.menu_id}/${menuRevisionId}.json`,
    diagnostics,
  };
}

function parseBundle(value: unknown): PublicMenuContentBundle {
  const parsed = PublicMenuContentBundleSchema.safeParse(value);
  if (!parsed.success) {
    throw new BundleProducerError(
      'invalid_bundle',
      `Produced bundle fails the v1 schema: ${parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

async function buildDish(
  request: MenuBundleRequest,
  requested: MenuBundleRequestDish,
  source: ApprovedDishSource,
  assets: ReadonlyMap<string, VerifiedT0Asset>,
): Promise<{
  dish: PublicMenuDish;
  gaps: BundleDiagnosticCode[];
  asset: AssetManifestEntry | null;
}> {
  const gaps: BundleDiagnosticCode[] = [];
  if (source.reviewState === 'incomplete') gaps.push('review_incomplete');

  const description = source.description.trim();
  if (description.length === 0) gaps.push('description_missing');

  const price = normalizePrice(source.priceAmount);
  if (!price.ok) gaps.push(price.reason);
  if (!source.priceCurrency) gaps.push('currency_missing');

  const ingredientNames =
    Array.isArray(source.ingredients) &&
    source.ingredients.length > 0 &&
    source.ingredients.every((name) => typeof name === 'string' && name.trim().length > 0)
      ? (source.ingredients as string[]).map((name) => name.trim())
      : null;
  if (!ingredientNames) gaps.push('ingredients_missing');

  if (requested.image_alt === null) gaps.push('alt_missing');

  const asset = requested.t0_asset_id ? assets.get(requested.t0_asset_id) : undefined;
  if (asset && asset.manifest.dish.dish_id !== source.dishId) {
    throw new BundleProducerError(
      'asset_dish_mismatch',
      `Asset ${asset.manifest.asset_id} belongs to dish ${asset.manifest.dish.dish_id}, not ${source.dishId}`,
    );
  }
  if (!asset) gaps.push('asset_missing');
  else if (asset.manifest.dish.revision_id !== source.dishRevisionId) {
    gaps.push('asset_revision_mismatch');
  }

  const identity = { dish_id: source.dishId, dish_revision_id: source.dishRevisionId };
  if (
    gaps.length > 0 ||
    !price.ok ||
    !source.priceCurrency ||
    !ingredientNames ||
    requested.image_alt === null ||
    !asset
  ) {
    return { dish: { ...identity, complete: false }, gaps, asset: null };
  }

  const { manifest } = asset;
  const card = webpVariant(manifest, 'card-480');
  const detail = webpVariant(manifest, 'detail-1280');
  const assetUrl = (path: string) => `${request.asset_base_url}/${manifest.asset_id}/${path}`;
  const alt = requested.image_alt;

  const ingredients = [];
  for (const [index, name] of ingredientNames.entries()) {
    ingredients.push({
      ingredient_id: await derivedUuid('ingredient:v1', source.dishRevisionId, String(index), name),
      name,
      description: null,
    });
  }

  return {
    dish: {
      ...identity,
      complete: true,
      name: source.name.trim(),
      description,
      price: { amount: price.amount, currency: source.priceCurrency },
      ingredients,
      allergens: requested.allergens,
      dietary: requested.dietary,
      images: {
        card: { url: assetUrl(card.path), width: card.width, height: card.height, alt },
        detail: { url: assetUrl(detail.path), width: detail.width, height: detail.height, alt },
      },
    },
    gaps,
    asset: {
      ...identity,
      asset_id: manifest.asset_id,
      card: {
        url: assetUrl(card.path),
        sha256: card.sha256,
        width: card.width,
        height: card.height,
      },
      detail: {
        url: assetUrl(detail.path),
        sha256: detail.sha256,
        width: detail.width,
        height: detail.height,
      },
    },
  };
}
