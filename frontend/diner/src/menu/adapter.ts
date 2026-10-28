import {
  type CompleteDish,
  DIETARY_VALUES,
  type Dish,
  type Menu,
  type MenuLoadResult,
  type WireDish,
  type WireMenuBundle,
} from './types';

// Chip labels compare without case, hyphens or spaces, so "gluten free" equals "Gluten-free".
export function chipKey(value: string): string {
  return value.toLowerCase().replace(/[\s-]+/g, '');
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
  const allergens = [...new Map((dish.allergens ?? []).map((a) => [chipKey(a), a])).values()];
  const containsGluten = allergens.some((a) => chipKey(a) === chipKey('Gluten'));
  const dietary = DIETARY_VALUES.filter(
    (value) =>
      dish.dietary.some((d) => chipKey(d) === chipKey(value)) &&
      !(containsGluten && value === 'Gluten-free'),
  );
  return {
    kind: 'complete',
    dishId: dish.dish_id,
    dishRevisionId: dish.dish_revision_id,
    categoryId,
    categoryName,
    name: dish.name,
    description: dish.description,
    price: dish.price,
    ingredients: dish.ingredients.map((i) => ({
      ingredientId: i.ingredient_id,
      name: i.name,
      description: i.description,
    })),
    allergens,
    dietary,
    images: dish.images,
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
  return {
    status: 'ready',
    menu: {
      source,
      publicationRevisionId,
      menuRevisionId: bundle.menu_revision_id,
      restaurant: bundle.restaurant,
      categories,
    },
  };
}

export function completeDishes(menu: Menu): CompleteDish[] {
  return menu.categories.flatMap((c) =>
    c.dishes.filter((d): d is CompleteDish => d.kind === 'complete'),
  );
}
