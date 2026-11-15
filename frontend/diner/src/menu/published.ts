// Published-menu adapter. The Bundle v1 schemas come from @peekaplate/contracts (S3-RES-02);
// this file verifies exact bytes, validates delivery identity and maps approved public content.
// Fixture mode uses its separate source and never calls this adapter.
import {
  type PublicMenuContentBundle,
  type PublicMenuDelivery,
  PublicMenuDeliverySchema,
  PublicMenuResponseSchema,
  verifyPublicMenuContentBytes,
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
          ...(dish.portion ? { portion: dish.portion } : {}),
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

export type PublishedSourceOptions = {
  apiBase: string;
  venueId: string;
  menuId: string;
  fetcher?: typeof fetch;
  // Called after a successful load, so the caller can hand the token to the tracking layer.
  onDelivery?: (info: { token: string; expiresAt: number; publicationId: string }) => void;
};

const withSignal = (signal?: AbortSignal) => (signal ? { signal } : {});

export function createPublishedMenuSource(options: PublishedSourceOptions): MenuSource {
  const doFetch: typeof fetch = options.fetcher ?? ((input, init) => fetch(input, init));
  const base = options.apiBase.replace(/\/+$/, '');

  return {
    async load(signal) {
      try {
        // 1. The small publication pointer. 404 covers missing, draft and withdrawn menus.
        const res = await doFetch(
          `${base}/public/venues/${options.venueId}/menus/${options.menuId}`,
          { cache: 'no-store', ...withSignal(signal) },
        );
        if (res.status === 404) return { status: 'unavailable' };
        if (!res.ok) return { status: 'error' };
        const rawResponse: unknown = await res.json();
        const response = PublicMenuResponseSchema.parse(rawResponse);

        // The answer must be for the menu that was asked for.
        if (response.venueId !== options.venueId || response.menuId !== options.menuId) {
          return { status: 'error' };
        }

        // 2. The immutable bundle. Public, so no credentials are sent.
        const bundleRes = await doFetch(response.bundle.url, {
          credentials: 'omit',
          ...withSignal(signal),
        });
        if (!bundleRes.ok) return { status: 'error' };

        // Raw bytes first. The hash is checked before anything is decoded or parsed.
        const bytes = new Uint8Array(await bundleRes.arrayBuffer());
        const content = await verifyPublicMenuContentBytes(bytes, response.bundle.contentHash);
        if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
        const delivery = PublicMenuDeliverySchema.parse({ response: rawResponse, content });
        const result = deliveryToMenu(delivery);
        if (result.status === 'ready') {
          options.onDelivery?.({
            token: delivery.response.menuToken,
            expiresAt: Date.parse(delivery.response.tokenExpiresAt),
            publicationId: delivery.response.publicationId,
          });
        }
        return result;
      } catch (error) {
        if (signal?.aborted) throw error;
        // A failed fetch is a TypeError. Bad data (a ZodError) is never reported as offline.
        // Only an explicit `false` means offline. Node and some browsers leave onLine undefined.
        const offline =
          error instanceof TypeError &&
          typeof navigator !== 'undefined' &&
          navigator.onLine === false;
        return { status: offline ? 'offline' : 'error' };
      }
    },
  };
}
