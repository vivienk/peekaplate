import {
  ALLERGENS,
  type CompleteDish,
  DIETARY_VALUES,
  type Dish,
  type Menu,
  type MenuImage,
  type MenuLoadResult,
} from './types';
import type { WireDish, WireImage, WireMenuBundle } from './wire';

export const FIXTURE_NOTICE = 'Fixture data';

// Chip labels compare without case, hyphens or spaces, so "gluten free" equals "Gluten-free".
export function chipKey(value: string): string {
  return value.toLowerCase().replace(/[\s-]+/g, '');
}

// Listing either value means the dish cannot also be shown as Gluten-free.
const EXCLUDES_GLUTEN_FREE = new Set([chipKey('Gluten'), chipKey('Wheat')]);

const ALLERGEN_LABELS = new Map<string, string>(
  ALLERGENS.flatMap((a) => [
    [chipKey(a.code), a.label],
    [chipKey(a.label), a.label],
  ]),
);

// An allergen outside the P0 list keeps its own text (a text-only chip); allergens are never dropped.
function allergenLabel(value: string): string {
  return ALLERGEN_LABELS.get(chipKey(value)) ?? value;
}

// Every field is copied by name, so unknown or draft fields in the data never reach screens.
function toImage(image: WireImage): MenuImage {
  return { url: image.url, width: image.width, height: image.height, alt: image.alt };
}

function toDish(dish: WireDish, categoryId: string, categoryName: string): Dish {
  // A dish without an ingredient list is an incomplete placeholder (DIN-01), even if marked complete.
  if (!dish.complete || dish.ingredients.length === 0) {
    return {
      kind: 'incomplete',
      dishId: dish.dish_id,
      dishRevisionId: dish.dish_revision_id,
      categoryId,
    };
  }
  const labels = (dish.allergens ?? []).map(allergenLabel);
  const allergens = [...new Map(labels.map((a) => [chipKey(a), a])).values()];
  const glutenFreeExcluded = allergens.some((a) => EXCLUDES_GLUTEN_FREE.has(chipKey(a)));
  const dietary = DIETARY_VALUES.filter(
    (value) =>
      dish.dietary.some((d) => chipKey(d) === chipKey(value)) &&
      !(glutenFreeExcluded && value === 'Gluten-free'),
  );
  return {
    kind: 'complete',
    dishId: dish.dish_id,
    dishRevisionId: dish.dish_revision_id,
    categoryId,
    categoryName,
    name: dish.name,
    description: dish.description,
    price: { amount: dish.price.amount, currency: dish.price.currency },
    ingredients: dish.ingredients.map((i) => ({
      ingredientId: i.ingredient_id,
      name: i.name,
      description: i.description,
    })),
    allergens,
    dietary,
    images: dish.images
      ? { card: toImage(dish.images.card), detail: toImage(dish.images.detail) }
      : null,
  };
}

export function toMenu(
  bundle: WireMenuBundle,
  source: Menu['source'],
  publicationRevisionId: string,
): MenuLoadResult {
  const categories = bundle.categories.map((c) => ({
    categoryId: c.category_id,
    name: c.name,
    dishes: c.dishes.map((d) => toDish(d, c.category_id, c.name)),
  }));
  if (categories.every((c) => c.dishes.length === 0)) return { status: 'empty' };
  const { logo } = bundle.restaurant;
  return {
    status: 'ready',
    menu: {
      source,
      notice: source === 'fixture' ? FIXTURE_NOTICE : null,
      venueId: bundle.venue_id,
      menuId: bundle.menu_id,
      publicationRevisionId,
      menuRevisionId: bundle.menu_revision_id,
      restaurant: { name: bundle.restaurant.name, logo: logo ? toImage(logo) : null },
      categories,
    },
  };
}

export function completeDishes(menu: Menu): CompleteDish[] {
  return menu.categories.flatMap((c) =>
    c.dishes.filter((d): d is CompleteDish => d.kind === 'complete'),
  );
}
