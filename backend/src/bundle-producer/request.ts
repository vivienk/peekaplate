import {
  PublicMenuAllergenCodeSchema,
  PublicMenuDietaryCodeSchema,
  PublicMenuImageSchema,
} from '@peekaplate/contracts';
import { z } from 'zod';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const text = z
  .string()
  .trim()
  .refine((value) => !value.includes('\u0000'), 'NUL is not supported');

// Base URLs are joined with '/' by the producer, so they must be bare HTTPS origins or paths.
const baseUrl = z
  .url()
  .refine((value) => value.startsWith('https://'), 'Base URLs require HTTPS')
  .refine((value) => !value.endsWith('/'), 'Base URLs must not end with /')
  .refine((value) => !value.includes('?') && !value.includes('#'), 'Base URLs take no query/hash');

/**
 * Operator-authored, restaurant-confirmed request. It is the approval record for menu
 * composition, category names, allergen/dietary codes and image alt text: no reviewed store
 * holds those facts yet, so the producer never infers them.
 */
export const MenuBundleRequestDishSchema = z.strictObject({
  dish_id: uuid,
  allergens: z
    .array(PublicMenuAllergenCodeSchema)
    .max(9)
    .refine((values) => new Set(values).size === values.length, 'Allergen values must be unique')
    .nullable(),
  dietary: z
    .array(PublicMenuDietaryCodeSchema)
    .max(3)
    .refine((values) => new Set(values).size === values.length, 'Dietary values must be unique'),
  image_alt: text.pipe(z.string().min(1).max(500)).nullable(),
  t0_asset_id: z
    .string()
    .regex(/^t0_[0-9a-f]{32}$/)
    .nullable(),
});

export const MenuBundleRequestSchema = z
  .strictObject({
    schema_version: z.literal(1),
    venue_id: uuid,
    menu_id: uuid,
    restaurant: z.strictObject({
      name: text.pipe(z.string().min(1).max(160)),
      logo: PublicMenuImageSchema.nullable(),
    }),
    bundle_base_url: baseUrl,
    asset_base_url: baseUrl,
    categories: z
      .array(
        z.strictObject({
          category_id: uuid,
          name: text.pipe(z.string().min(1).max(160)),
          dishes: z.array(MenuBundleRequestDishSchema).max(500),
        }),
      )
      .max(100),
  })
  .superRefine((request, ctx) => {
    const categoryIds = new Set<string>();
    const dishIds = new Set<string>();
    for (const [categoryIndex, category] of request.categories.entries()) {
      if (categoryIds.has(category.category_id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['categories', categoryIndex, 'category_id'],
          message: 'Category IDs must be unique',
        });
      }
      categoryIds.add(category.category_id);
      for (const [dishIndex, dish] of category.dishes.entries()) {
        if (dishIds.has(dish.dish_id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['categories', categoryIndex, 'dishes', dishIndex, 'dish_id'],
            message: 'Dish IDs must be unique across the menu',
          });
        }
        dishIds.add(dish.dish_id);
      }
    }
  });

export type MenuBundleRequest = z.infer<typeof MenuBundleRequestSchema>;
export type MenuBundleRequestDish = z.infer<typeof MenuBundleRequestDishSchema>;

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

const T0AssetVariantSchema = z
  .object({
    name: z.enum(['card-480', 'detail-1280']),
    format: z.enum(['webp', 'jpeg']),
    path: z.string(),
    sha256: sha256Hex,
    size_bytes: z.number().int().positive(),
    width: z.number().int().positive().max(16_384),
    height: z.number().int().positive().max(16_384),
  })
  .refine(
    (variant) => variant.path === `${variant.name}.${variant.format === 'webp' ? 'webp' : 'jpg'}`,
    'Variant filename must match its name and format',
  );

/** Reader for PR #25 `prepare_t0_bundle` manifests; only the fields the producer uses. */
export const T0AssetManifestSchema = z
  .object({
    schema_version: z.literal(1),
    asset_id: z.string().regex(/^t0_[0-9a-f]{32}$/),
    tier: z.literal('T0'),
    source: z.object({
      sha256: sha256Hex,
      capture_evidence: text.pipe(z.string().min(1)),
    }),
    dish: z.object({ dish_id: uuid, revision_id: uuid }),
    variants: z.array(T0AssetVariantSchema).length(4),
  })
  .refine(
    (manifest) =>
      ['card-480', 'detail-1280'].every(
        (name) =>
          manifest.variants.filter((variant) => variant.name === name && variant.format === 'webp')
            .length === 1,
      ),
    'Manifest needs exactly one webp card-480 and one webp detail-1280 variant',
  );

export type T0AssetManifest = z.infer<typeof T0AssetManifestSchema>;
export type T0AssetVariant = z.infer<typeof T0AssetVariantSchema>;

export function webpVariant(manifest: T0AssetManifest, name: 'card-480' | 'detail-1280') {
  const variant = manifest.variants.find(
    (candidate) => candidate.name === name && candidate.format === 'webp',
  );
  if (!variant) throw new Error(`Manifest ${manifest.asset_id} has no webp ${name} variant`);
  return variant;
}
