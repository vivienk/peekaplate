// Maps the owner dashboard's menu item (MenuItem in frontend/console/src/owner-dashboard/data.ts,
// the data behind the dashboard Menu screen and the S09 Add/Edit dish form) to an S10 review row.
// S10 therefore shows the same dishes as the Menu screen instead of keeping its own dataset.
// The type below is structural, so this file does not import the demo module and keeps working
// whether or not the Screen 9 PR (#172) has added the allergen fields.
import type { DishFacts, ReviewDish } from './reviewDishes';

export interface DashboardMenuItem {
  id: string | null;
  name: string;
  cat: string;
  price: number | string;
  ing: readonly string[];
  aiIng: readonly string[];
  aiReviewed: boolean;
  /** Dish description, when the source has one. */
  desc?: string;
  /** Id of the dish photo, when the source has one. */
  photoId?: string | null;
  /** True when the owner confirmed the allergens, including confirming that there are none. */
  allergensConfirmed?: boolean;
  /** Serving size, when the source has one (not in the draft contract yet). */
  servingSize?: string | null;
  /** Recorded allergens. Added to the dashboard data by the Screen 9 PR (#172). */
  alg?: readonly string[];
  /** Allergens suggested by AI and not yet reviewed (#172). */
  aiAlg?: readonly string[];
}

/** Nothing listed is "unknown"; AI-suggested items the owner has not reviewed are "proposed". */
function factsOf(
  items: readonly string[],
  aiItems: readonly string[],
  aiReviewed: boolean,
): DishFacts {
  if (items.length === 0) return { status: 'unknown', items: [] };
  const proposed = !aiReviewed && items.some((item) => aiItems.includes(item));
  return { status: proposed ? 'proposed' : 'confirmed', items };
}

export function menuItemToReviewDish(item: DashboardMenuItem): ReviewDish {
  const price = String(item.price).trim();
  return {
    id: item.id ?? `new-${item.name.trim() || 'dish'}`,
    name: item.name.trim() === '' ? null : item.name,
    category: item.cat.trim() === '' ? null : item.cat,
    description: item.desc?.trim() ? item.desc : null,
    photoId: item.photoId ?? null,
    ...(item.servingSize !== undefined && { servingSize: item.servingSize }),
    priceAmount: price === '' ? null : price,
    ingredients: factsOf(item.ing, item.aiIng, item.aiReviewed),
    allergens:
      item.allergensConfirmed === true && (item.alg ?? []).length === 0
        ? { status: 'confirmed', items: [] }
        : factsOf(item.alg ?? [], item.aiAlg ?? [], item.aiReviewed),
  };
}
