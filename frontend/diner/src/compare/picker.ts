// Compare picker (S3-DIN-02.3): which dishes the diner can pick as the other side of a comparison.
// Search reuses the S3-DIN-01.4 menu rules rather than a second copy. Like search, it makes no API
// call, fires no events and never stores or logs the query.
import { completeDishes } from '../menu/adapter';
import { type MenuSearchResult, searchMenu } from '../menu/search';
import type { Menu } from '../menu/types';

// Dishes already in the comparison: the kept dish, or both shown dishes when replacing one side.
export type PickerExclusions = readonly string[];

// Incomplete dishes are never options, so they can't be picked or compared.
export function pickerOptions(menu: Menu, exclude: PickerExclusions, query = ''): MenuSearchResult {
  const excluded = new Set(exclude);
  const result =
    query.trim() === ''
      ? { dishIds: completeDishes(menu).map((d) => d.dishId), allergyNotice: false }
      : searchMenu(menu, query);
  return { ...result, dishIds: result.dishIds.filter((id) => !excluded.has(id)) };
}

export function isSelectable(menu: Menu, exclude: PickerExclusions, dishId: string): boolean {
  return !exclude.includes(dishId) && completeDishes(menu).some((d) => d.dishId === dishId);
}

// One dish at a time: picking another replaces the previous choice. A dish already in the
// comparison or an incomplete one is ignored, so the same dish can never be compared with itself.
export function selectOption(
  menu: Menu,
  exclude: PickerExclusions,
  current: string | null,
  dishId: string,
): string | null {
  return isSelectable(menu, exclude, dishId) ? dishId : current;
}
