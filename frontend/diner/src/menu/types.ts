// The diner's internal menu model: what screens, search and event triggers read. Screens import
// this module only; the data format lives in ./wire and is read only by the adapter.
export const DIETARY_VALUES = ['Vegan', 'Vegetarian', 'Gluten-free'] as const;
export type DietaryValue = (typeof DIETARY_VALUES)[number];

export type MenuImage = { url: string; width: number; height: number; alt: string };

export type Ingredient = { ingredientId: string; name: string; description: string | null };

export type IncompleteDish = {
  kind: 'incomplete';
  dishId: string;
  dishRevisionId: string;
  categoryId: string;
};

export type CompleteDish = {
  kind: 'complete';
  dishId: string;
  dishRevisionId: string;
  categoryId: string;
  categoryName: string;
  name: string;
  description: string;
  price: { amount: string; currency: string };
  ingredients: Ingredient[];
  allergens: string[];
  dietary: DietaryValue[];
  images: { card: MenuImage; detail: MenuImage } | null;
};

export type Dish = IncompleteDish | CompleteDish;

export type MenuCategory = { categoryId: string; name: string; dishes: Dish[] };

export type Menu = {
  source: 'fixture' | 'published';
  // Visible label screens must show for non-published data, e.g. "Fixture data".
  notice: string | null;
  publicationRevisionId: string;
  menuRevisionId: string;
  restaurant: { name: string; logo: MenuImage | null };
  categories: MenuCategory[];
};

export type MenuLoadResult =
  | { status: 'ready'; menu: Menu }
  | { status: 'empty' | 'unavailable' | 'error' | 'offline' };

// DIN-03 adds a published-menu source behind this same interface.
export interface MenuSource {
  load(signal?: AbortSignal): Promise<MenuLoadResult>;
}
