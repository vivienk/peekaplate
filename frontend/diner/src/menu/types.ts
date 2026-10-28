// Wire shape mirrors the draft S3-RES-02 PublicMenuContentBundleSchema (PR #43). Replace these
// with the @peekaplate/contracts types once that schema merges.
export type WireImage = { url: string; width: number; height: number; alt: string };

export type WireIngredient = { ingredient_id: string; name: string; description: string | null };

export type WireIncompleteDish = { dish_id: string; dish_revision_id: string; complete: false };

export type WireCompleteDish = {
  dish_id: string;
  dish_revision_id: string;
  complete: true;
  name: string;
  description: string;
  price: { amount: string; currency: string };
  ingredients: WireIngredient[];
  dietary: string[];
  // Not in the RES-02 draft yet: no approved allergen list exists, so only fixtures supply it.
  allergens?: string[];
  images: { card: WireImage; detail: WireImage } | null;
};

export type WireDish = WireIncompleteDish | WireCompleteDish;

export type WireMenuBundle = {
  schema_version: 1;
  venue_id: string;
  menu_id: string;
  menu_revision_id: string;
  restaurant: { name: string; logo: WireImage | null };
  categories: { category_id: string; name: string; dishes: WireDish[] }[];
};

// Diner shape: what screens, search and event triggers read.
export const DIETARY_VALUES = ['Vegan', 'Vegetarian', 'Gluten-free'] as const;
export type DietaryValue = (typeof DIETARY_VALUES)[number];

export type MenuImage = WireImage;

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
