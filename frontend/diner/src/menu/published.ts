// Published-menu adapter. The Bundle v1 schemas come from @peekaplate/contracts (S3-RES-02);
// this file only validates the delivery and maps it into the screen model. Keep all key-name
// mapping in this file. Hash verification is a single, clearly marked step and is skipped in
// fixture mode.
import {
  type PublicMenuContentBundle,
  type PublicMenuDelivery,
  PublicMenuDeliverySchema,
} from '@peekaplate/contracts';
import { toMenu, type WireMenuBundle } from './adapter';
import type { MenuLoadResult, MenuSource } from './types';

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

// Validates the whole response and bundle. Throws on any unknown key or invalid value.
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
