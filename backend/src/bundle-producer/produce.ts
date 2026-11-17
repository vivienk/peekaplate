import {
  canonicalJson,
  type PlateCalibration,
  type PublicMenuAllergenCode,
  type PublicMenuContentBundle,
  PublicMenuContentBundleSchema,
  type PublicMenuDish,
  type PublicPortion,
  servingDimensionsMatch,
  sha256,
  verifyPublicMenuContentBytes,
} from '@peekaplate/contracts';
import { matchesApprovedOwnerPortion, type PreparedApprovedPortion } from './approved-portions';
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
  portionCalibration?: PlateCalibration | null;
  servingSize?: string | null;
  servingCount?: number | null;
  dishId: string;
  dishRevisionId: string;
  name: string;
  description: string;
  priceAmount: string | null;
  priceCurrency: string | null;
  ingredients: unknown;
  reviewState: 'none' | 'corrected' | 'incomplete' | 'rejected';
  approvedAllergens?: PublicMenuAllergenCode[] | null;
  approvedCategory?: string | null;
  /** The owner-selected photo snapshotted onto this approved revision (approved facts). */
  approvedPhotoId?: string | null;
};

/**
 * An owner-uploaded, owner-approved dish photo for Part A preparation. It is the exact stored
 * upload (hash-checked by the caller), bound to one approved dish revision and its selected
 * photo ID. The photo alone authorizes neither a portion nor physical dimensions.
 */
export type OwnerApprovedPhoto = {
  dishId: string;
  dishRevisionId: string;
  photoId: string;
  url: string;
  sha256: string;
  width: number;
  height: number;
};

export type ProduceOptions = {
  /** Owner-approved photos by dish ID, used when a dish has no T0 asset. */
  ownerPhotos?: ReadonlyMap<string, OwnerApprovedPhoto>;
  /** Exact validated private approval, bound to the selected photo and canonical revision. */
  ownerPortions?: ReadonlyMap<string, PreparedApprovedPortion>;
  /**
   * What a dish without any photo becomes: an identity-only placeholder (operator default) or a
   * complete text-only dish with images: null (the agreed owner fallback).
   */
  missingPhoto?: 'placeholder' | 'text_only';
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
  | 'asset_revision_mismatch'
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
  // Exactly one of: a reviewed T0 asset, or an owner-approved upload (never labelled T0).
  asset_id?: string;
  owner_photo_id?: string;
  portion?: PublicPortion;
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
  options: ProduceOptions = {},
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
      if (
        source.approvedCategory !== undefined &&
        source.approvedCategory !== null &&
        source.approvedCategory !== category.name
      )
        throw new BundleProducerError(
          'invalid_request',
          `Dish ${source.dishId} category differs from its approved revision`,
        );
      const built = await buildDish(input, requested, source, assets, options);
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
    canonicalJson({
      schema_version: 1,
      assets: assetEntries,
      ...(input.restaurant.logo ? { restaurant_logo: input.restaurant.logo } : {}),
    }),
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
  const menuRevisionId = await derivedUuid('menu-revision:v1', canonicalJson(withoutRevision));
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
  options: ProduceOptions,
): Promise<{
  dish: PublicMenuDish;
  gaps: BundleDiagnosticCode[];
  asset: AssetManifestEntry | null;
}> {
  const gaps: BundleDiagnosticCode[] = [];
  if (source.reviewState === 'incomplete') gaps.push('review_incomplete');

  const description = source.description.trim();
  if (
    description.length === 0 ||
    description.length > 4000 ||
    source.description.includes('\u0000')
  ) {
    gaps.push('description_missing');
  }

  const price = normalizePrice(source.priceAmount);
  if (!price.ok) gaps.push(price.reason);
  const currency = source.priceCurrency;
  if (!currency || !/^[A-Z]{3}$/.test(currency)) {
    gaps.push('currency_missing');
  }

  const ingredientNames =
    Array.isArray(source.ingredients) &&
    source.ingredients.length > 0 &&
    source.ingredients.length <= 100 &&
    source.ingredients.every((name) => {
      if (typeof name !== 'string' || name.includes('\u0000')) return false;
      const trimmed = name.trim();
      return trimmed.length > 0 && trimmed.length <= 160;
    })
      ? (source.ingredients as string[]).map((name) => name.trim())
      : null;
  if (!ingredientNames) gaps.push('ingredients_missing');

  const asset = requested.t0_asset_id ? assets.get(requested.t0_asset_id) : undefined;
  if (asset && asset.manifest.dish.dish_id !== source.dishId) {
    throw new BundleProducerError(
      'asset_dish_mismatch',
      `Asset ${asset.manifest.asset_id} belongs to dish ${asset.manifest.dish.dish_id}, not ${source.dishId}`,
    );
  }
  const ownerPhoto = asset ? undefined : options.ownerPhotos?.get(source.dishId);
  if (
    ownerPhoto &&
    (ownerPhoto.dishId !== source.dishId ||
      ownerPhoto.dishRevisionId !== source.dishRevisionId ||
      !source.approvedPhotoId ||
      ownerPhoto.photoId !== source.approvedPhotoId)
  ) {
    throw new BundleProducerError(
      'asset_revision_mismatch',
      `Owner photo for dish ${source.dishId} is not the photo approved on its revision`,
    );
  }
  // Flat uploads cannot authorize portions; only an exact independently approved cutout can.
  if (
    !asset &&
    requested.portion &&
    !(
      ownerPhoto &&
      matchesApprovedOwnerPortion(
        options.ownerPortions?.get(source.dishId),
        ownerPhoto.photoId,
        ownerPhoto.sha256,
        requested.portion,
      )
    )
  ) {
    throw new BundleProducerError(
      'asset_revision_mismatch',
      'A portion requires a reviewed T0 asset or exact approved owner cutout',
    );
  }
  const textOnly = !asset && !ownerPhoto && options.missingPhoto === 'text_only';
  if (requested.image_alt === null && !textOnly) gaps.push('alt_missing');
  if (!asset && !ownerPhoto && !textOnly) gaps.push('asset_missing');
  else if (asset && asset.manifest.dish.revision_id !== source.dishRevisionId) {
    gaps.push('asset_revision_mismatch');
  }

  const identity = { dish_id: source.dishId, dish_revision_id: source.dishRevisionId };
  if (
    requested.portion &&
    (requested.portion.dish_id !== source.dishId ||
      requested.portion.dish_revision_id !== source.dishRevisionId)
  ) {
    throw new BundleProducerError(
      'asset_revision_mismatch',
      'Portion must belong to the approved dish revision',
    );
  }
  if (
    requested.portion?.physical_size &&
    requested.portion.physical_size.serving_count !== (source.servingCount ?? undefined)
  ) {
    throw new BundleProducerError(
      'asset_revision_mismatch',
      'Plate calibration must match the approved serving count',
    );
  }
  if (
    !asset &&
    requested.portion?.physical_size &&
    (!source.portionCalibration ||
      !servingDimensionsMatch(source.servingSize, source.portionCalibration) ||
      canonicalJson(requested.portion.physical_size.plate) !==
        canonicalJson(source.portionCalibration))
  ) {
    throw new BundleProducerError(
      'asset_revision_mismatch',
      'Physical dimensions must match the measurement approved on this dish revision',
    );
  }
  if (
    gaps.length > 0 ||
    !price.ok ||
    !currency ||
    !ingredientNames ||
    (requested.image_alt === null && !textOnly) ||
    (!asset && !ownerPhoto && !textOnly)
  ) {
    return { dish: { ...identity, complete: false }, gaps, asset: null };
  }

  const alt = requested.image_alt;
  let images: Extract<PublicMenuDish, { complete: true }>['images'] = null;
  let assetEntry: AssetManifestEntry | null = null;
  if (asset && alt !== null) {
    const { manifest } = asset;
    const card = webpVariant(manifest, 'card-480');
    const detail = webpVariant(manifest, 'detail-1280');
    const assetUrl = (path: string) => `${request.asset_base_url}/${manifest.asset_id}/${path}`;
    images = {
      card: { url: assetUrl(card.path), width: card.width, height: card.height, alt },
      detail: { url: assetUrl(detail.path), width: detail.width, height: detail.height, alt },
    };
    assetEntry = {
      ...identity,
      asset_id: manifest.asset_id,
      ...(requested.portion ? { portion: requested.portion } : {}),
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
    };
  } else if (ownerPhoto && alt !== null) {
    const image = { url: ownerPhoto.url, width: ownerPhoto.width, height: ownerPhoto.height, alt };
    images = { card: image, detail: image };
    const variant = {
      url: ownerPhoto.url,
      sha256: ownerPhoto.sha256,
      width: ownerPhoto.width,
      height: ownerPhoto.height,
    };
    assetEntry = {
      ...identity,
      owner_photo_id: ownerPhoto.photoId,
      ...(requested.portion ? { portion: requested.portion } : {}),
      card: variant,
      detail: variant,
    };
  }

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
      ...(source.servingCount != null ? { serving_count: source.servingCount } : {}),
      ...(requested.portion ? { portion: requested.portion } : {}),
      name: source.name.trim(),
      description,
      price: { amount: price.amount, currency },
      ingredients,
      allergens:
        source.approvedAllergens === undefined ? requested.allergens : source.approvedAllergens,
      dietary: requested.dietary,
      images,
    },
    gaps,
    asset: assetEntry,
  };
}
