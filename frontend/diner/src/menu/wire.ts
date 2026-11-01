// Wire shape mirrors the draft S3-RES-02 PublicMenuContentBundleSchema (PR #43). Only the adapter
// and fixtures read it; screens use ./types. Replace with @peekaplate/contracts once RES-02 merges.
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
