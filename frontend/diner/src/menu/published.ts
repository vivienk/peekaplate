// Copied from PR #43, commit a1c264c86347dc222929e2a4dc20312170674d5d.
// Not yet exported from packages/contracts. Keep all key-name mapping in this file.
// Hash verification is a single, clearly marked step and is skipped in fixture mode.

import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/);

export const HealthResponseSchema = z.strictObject({
  status: z.literal('ok'),
  service: z.literal('peekaplate-api'),
  stage: z.literal('foundation'),
});

// Initial dish-level contract. Broader event types require their own reviewed payload schemas.
export const DishIntentEventSchema = z
  .strictObject({
    eventId: z.uuid(),
    schemaVersion: z.literal(1),
    sessionId: z.uuid(),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    eventType: z.enum(['dish_open', 'portion_compare']),
    occurredAt: z.iso.datetime(),
    publicationHash: hash,
    dishRevisionHash: hash,
    displayedTier: z.enum(['T0', 'T1', 'T2']),
    rendererVersion: z.string().min(1).max(64).nullable(),
    manifestHash: hash.nullable(),
    availabilityVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    experimentAssignment: z
      .strictObject({
        experimentId: z.uuid(),
        blockId: z.string().min(1).max(64),
        arm: z.string().min(1).max(32),
      })
      .nullable(),
  })
  .superRefine((event, ctx) => {
    if (event.displayedTier !== 'T0' && (!event.rendererVersion || !event.manifestHash)) {
      ctx.addIssue({
        code: 'custom',
        path: ['displayedTier'],
        message: 'Enhanced exposures require renderer and manifest versions',
      });
    }
    if (event.displayedTier === 'T0' && event.rendererVersion !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['rendererVersion'],
        message: 'Photo exposures have no active renderer',
      });
    }
    if (event.displayedTier === 'T0' && event.manifestHash !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['manifestHash'],
        message: 'Photo exposures have no enhanced manifest',
      });
    }
  });

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type DishIntentEvent = z.infer<typeof DishIntentEventSchema>;

const uuid = z.uuid().transform((value) => value.toLowerCase());
const postgresText = z
  .string()
  .refine((value) => !value.includes('\u0000'), 'NUL is not supported');

export const VenueScopeSchema = z.strictObject({ venueId: uuid });
export const DishRevisionScopeSchema = z.strictObject({ venueId: uuid, dishId: uuid });

export const CreateDishRevisionSchema = z.strictObject({
  commandId: uuid,
  expectedVersion: z.number().int().nonnegative().max(2_147_483_646),
  name: postgresText.trim().min(1).max(160),
  description: postgresText.trim().max(4000),
});

export const DishRevisionSchema = z.strictObject({
  dishId: uuid,
  revisionId: uuid,
  version: z.number().int().positive().max(2_147_483_647),
  name: postgresText.min(1).max(160),
  description: postgresText.max(4000),
});

export type CreateDishRevision = z.infer<typeof CreateDishRevisionSchema>;
export type DishRevision = z.infer<typeof DishRevisionSchema>;

export const MenuScopeSchema = z.strictObject({ venueId: uuid, menuId: uuid });

const commandVersion = z.number().int().nonnegative().max(2_147_483_646);

export const ApproveMenuRevisionSchema = z.strictObject({
  commandId: uuid,
  expectedVersion: commandVersion,
  menuRevisionId: uuid,
  contentApprovalId: uuid,
  assetApprovalId: uuid,
});

export const MenuApprovalSchema = z.strictObject({
  menuId: uuid,
  approvalId: uuid,
  version: z.number().int().positive().max(2_147_483_647),
  menuRevisionId: uuid,
  contentApprovalId: uuid,
  contentHash: hash,
  assetApprovalId: uuid,
  assetManifestHash: hash,
  status: z.literal('approved'),
});

export const PublishMenuSchema = z.strictObject({
  commandId: uuid,
  expectedVersion: commandVersion,
  approvalId: uuid,
});

export const WithdrawMenuSchema = z.strictObject({
  commandId: uuid,
  expectedVersion: commandVersion,
});

export const MenuPublicationSchema = z.strictObject({
  menuId: uuid,
  publicationId: uuid,
  version: z.number().int().positive().max(2_147_483_647),
  approvalId: uuid,
  publicationHash: hash,
  availabilityVersion: z.number().int().positive().max(2_147_483_647),
  status: z.enum(['published', 'withdrawn']),
});

export type ApproveMenuRevision = z.infer<typeof ApproveMenuRevisionSchema>;
export type MenuApproval = z.infer<typeof MenuApprovalSchema>;
export type PublishMenu = z.infer<typeof PublishMenuSchema>;
export type WithdrawMenu = z.infer<typeof WithdrawMenuSchema>;
export type MenuPublication = z.infer<typeof MenuPublicationSchema>;

export const PublicMenuBundleSchema = z.strictObject({
  url: z.url().refine((value) => value.startsWith('https://'), 'Public bundles require HTTPS'),
  contentHash: hash,
  assetManifestHash: hash,
});

const publicMenuText = postgresText.trim();
const publicHttpsUrl = z
  .url()
  .refine((value) => value.startsWith('https://'), 'Public menu assets require HTTPS');

export const PublicMenuImageSchema = z.strictObject({
  url: publicHttpsUrl,
  width: z.number().int().positive().max(16_384),
  height: z.number().int().positive().max(16_384),
  alt: publicMenuText.min(1).max(500),
});

export const PublicMenuIngredientSchema = z.strictObject({
  ingredient_id: uuid,
  name: publicMenuText.min(1).max(160),
  description: publicMenuText.max(1000).nullable(),
});

const publicMenuDishIdentity = {
  dish_id: uuid,
  dish_revision_id: uuid,
};

export const PublicMenuIncompleteDishSchema = z.strictObject({
  ...publicMenuDishIdentity,
  complete: z.literal(false),
});

export const PublicMenuAllergenCodeSchema = z.enum([
  'milk',
  'egg',
  'fish',
  'crustacean shellfish',
  'tree nut',
  'peanut',
  'wheat',
  'soy',
  'sesame',
]);

export const PublicMenuDietaryCodeSchema = z.enum(['vegan', 'vegetarian', 'gluten-free']);

export const PublicMenuCompleteDishSchema = z.strictObject({
  ...publicMenuDishIdentity,
  complete: z.literal(true),
  name: publicMenuText.min(1).max(160),
  description: publicMenuText.min(1).max(4000),
  price: z.strictObject({
    amount: z.string().regex(/^(0|[1-9]\d{0,7})(\.\d{1,2})?$/),
    currency: z.string().regex(/^[A-Z]{3}$/),
  }),
  ingredients: z.array(PublicMenuIngredientSchema).max(100),
  allergens: z
    .array(PublicMenuAllergenCodeSchema)
    .max(9)
    .refine((values) => new Set(values).size === values.length, 'Allergen values must be unique')
    .nullable(),
  dietary: z
    .array(PublicMenuDietaryCodeSchema)
    .max(3)
    .refine((values) => new Set(values).size === values.length, 'Dietary values must be unique'),
  images: z.strictObject({
    card: PublicMenuImageSchema,
    detail: PublicMenuImageSchema,
  }),
});

export const PublicMenuDishSchema = z.discriminatedUnion('complete', [
  PublicMenuIncompleteDishSchema,
  PublicMenuCompleteDishSchema,
]);

export const PublicMenuCategorySchema = z.strictObject({
  category_id: uuid,
  name: publicMenuText.min(1).max(160),
  dishes: z.array(PublicMenuDishSchema).max(500),
});

export const PublicMenuContentBundleSchema = z
  .strictObject({
    schema_version: z.literal(1),
    venue_id: uuid,
    menu_id: uuid,
    menu_revision_id: uuid,
    restaurant: z.strictObject({
      name: publicMenuText.min(1).max(160),
      logo: PublicMenuImageSchema.nullable(),
    }),
    categories: z.array(PublicMenuCategorySchema).max(100),
  })
  .superRefine((bundle, ctx) => {
    const categoryIds = new Set<string>();
    const dishIds = new Set<string>();
    for (const [categoryIndex, category] of bundle.categories.entries()) {
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
        if (dish.complete) {
          const ingredientIds = new Set<string>();
          for (const [ingredientIndex, ingredient] of dish.ingredients.entries()) {
            if (ingredientIds.has(ingredient.ingredient_id)) {
              ctx.addIssue({
                code: 'custom',
                path: [
                  'categories',
                  categoryIndex,
                  'dishes',
                  dishIndex,
                  'ingredients',
                  ingredientIndex,
                  'ingredient_id',
                ],
                message: 'Ingredient IDs must be unique within a dish',
              });
            }
            ingredientIds.add(ingredient.ingredient_id);
          }
        }
      }
    }
  });

export const PublicMenuResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  venueId: uuid,
  menuId: uuid,
  menuRevisionId: uuid,
  publicationId: uuid,
  publicationHash: hash,
  availabilityVersion: z.number().int().positive().max(2_147_483_647),
  tier: z.literal('T0'),
  bundle: PublicMenuBundleSchema,
  menuToken: z.string().min(1).max(8192),
  tokenExpiresAt: z.iso.datetime(),
});

export const PublicMenuDeliverySchema = z
  .strictObject({
    response: PublicMenuResponseSchema,
    content: PublicMenuContentBundleSchema,
  })
  .superRefine(({ response, content }, ctx) => {
    const identities = [
      ['venue_id', response.venueId, content.venue_id],
      ['menu_id', response.menuId, content.menu_id],
      ['menu_revision_id', response.menuRevisionId, content.menu_revision_id],
    ] as const;
    for (const [field, expected, actual] of identities) {
      if (actual !== expected) {
        ctx.addIssue({
          code: 'custom',
          path: ['content', field],
          message: `${field} must match the active public response`,
        });
      }
    }
  });
export type PublicMenuContentBundle = z.infer<typeof PublicMenuContentBundleSchema>;
export type PublicMenuResponse = z.infer<typeof PublicMenuResponseSchema>;
export type PublicMenuDelivery = z.infer<typeof PublicMenuDeliverySchema>;

import { toMenu, type WireDish, type WireImage, type WireMenuBundle } from './adapter';
import type { Menu, MenuLoadResult, MenuSource } from './types';

// The single public-contract-to-screen mapping. It copies only approved public fields and never
// fills in absent facts; `allergens: null` stays an omitted UI declaration, not an "allergen-free" claim.
export function publicBundleToWire(bundle: PublicMenuContentBundle): WireMenuBundle {
  return {
    schema_version: bundle.schema_version,
    venue_id: bundle.venue_id,
    menu_id: bundle.menu_id,
    menu_revision_id: bundle.menu_revision_id,
    restaurant: {
      name: bundle.restaurant.name,
      logo: bundle.restaurant.logo ? { ...bundle.restaurant.logo } : null,
    },
    categories: bundle.categories.map((category) => ({
      category_id: category.category_id,
      name: category.name,
      dishes: category.dishes.map((dish) => {
        if (!dish.complete) {
          return {
            dish_id: dish.dish_id,
            dish_revision_id: dish.dish_revision_id,
            complete: false,
          };
        }
        return {
          dish_id: dish.dish_id,
          dish_revision_id: dish.dish_revision_id,
          complete: true,
          name: dish.name,
          description: dish.description,
          price: { amount: dish.price.amount, currency: dish.price.currency },
          ingredients: dish.ingredients.map((ingredient) => ({
            ingredient_id: ingredient.ingredient_id,
            name: ingredient.name,
            description: ingredient.description,
          })),
          ...(dish.allergens === null ? {} : { allergens: [...dish.allergens] }),
          dietary: dish.dietary.map((value) => {
            switch (value) {
              case 'vegan':
                return 'Vegan';
              case 'vegetarian':
                return 'Vegetarian';
              case 'gluten-free':
                return 'Gluten-free';
            }
          }),
          images: { card: { ...dish.images.card }, detail: { ...dish.images.detail } },
        };
      }),
    })),
  };
}

export function parsePublishedDelivery(input: unknown): PublicMenuDelivery {
  return PublicMenuDeliverySchema.parse(input);
}

export function deliveryToMenu(delivery: PublicMenuDelivery): MenuLoadResult {
  return toMenu(publicBundleToWire(delivery.content), 'published', delivery.response.publicationId);
}

// Hash check is a single, clearly marked step. Fixture mode skips it. Live mode fails closed
// until the hash rule (UTF-8 bytes vs canonical serialization) is agreed with the producer.
export function verifyContentHash(
  _delivery: PublicMenuDelivery,
  mode: 'fixture' | 'live' = 'live',
): boolean {
  if (mode === 'fixture') return true;
  // INTERIM: hash rule is not agreed yet. Do not claim hash integrity is verified.
  return false;
}

export function createPublishedMenuSource(): MenuSource {
  return {
    async load() {
      return { status: 'error' };
    },
  };
}
