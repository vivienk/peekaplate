// Menu search (S3-DIN-01, DN-2). A plain function over the menu already loaded, so the DIN-02
// Compare picker reuses the same rules. It makes no API call, fires no events and never stores or
// logs the query.
import { chipKey, completeDishes } from './adapter';
import { ALLERGENS, type CompleteDish, DIETARY_VALUES, type Menu } from './types';

export type MenuSearchResult = {
  // Matching complete dishes, in menu order across all categories.
  dishIds: string[];
  // The query is an allergen or dietary value, so the view shows the staff allergy line.
  allergyNotice: boolean;
};

const NO_MATCH: MenuSearchResult = { dishIds: [], allergyNotice: false };

// Other names diners use for a P0 allergen, e.g. "Soya" from the Figma icon set.
const ALLERGEN_ALIASES: Partial<Record<(typeof ALLERGENS)[number]['code'], string[]>> = {
  soy: ['soya', 'soybean', 'soybeans'],
  sesame: ['sesame seed', 'sesame seeds'],
};

// A P0 allergen chip matches its code, its label or an alias, so "egg" and "eggs" both find "Eggs"
// and "soya" finds "Soy". Keyed by label because the adapter turns P0 codes into labels.
const ALLERGEN_KEYS = new Map<string, string[]>(
  ALLERGENS.map((a) => [
    chipKey(a.label),
    [a.code, a.label, ...(ALLERGEN_ALIASES[a.code] ?? [])].map(chipKey),
  ]),
);

// Common allergy terms outside the P0 list. They show the staff line even when no dish lists them,
// so searching them never reads as "this menu is free from it"; a term a dish does list as an
// allergen (e.g. Mustard) also matches that dish.
const NOTICE_ONLY_TERMS = [
  'gluten',
  'shellfish',
  'crustacean',
  'nut',
  'nuts',
  'dairy',
  'mustard',
  'celery',
  'lupin',
  'mollusc',
  'molluscs',
  'sulphite',
  'sulphites',
  'sulfite',
  'sulfites',
];

const NOTICE_KEYS = new Set([
  ...[...ALLERGEN_KEYS.values()].flat(),
  ...DIETARY_VALUES.map(chipKey),
  ...NOTICE_ONLY_TERMS.map(chipKey),
]);

function allergenKeys(value: string): string[] {
  return ALLERGEN_KEYS.get(chipKey(value)) ?? [chipKey(value)];
}

// Name, category and ingredients match partially, ignoring case and repeated spaces. Hyphens are
// kept here on purpose; chip matching uses chipKey, which drops them ("gluten-free" = "glutenfree").
function textKey(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

// Allergen and dietary values match the whole chip label, so "gluten" never finds "Gluten-free".
function matchesChip(dish: CompleteDish, key: string): boolean {
  return (
    dish.allergens.some((value) => allergenKeys(value).includes(key)) ||
    dish.dietary.some((value) => chipKey(value) === key)
  );
}

// The description is never searched (DIN-01).
function matchesText(dish: CompleteDish, text: string): boolean {
  return [dish.name, dish.categoryName, ...dish.ingredients.map((i) => i.name)].some((value) =>
    textKey(value).includes(text),
  );
}

export function searchMenu(menu: Menu, query: string): MenuSearchResult {
  const text = textKey(query);
  const key = chipKey(query);
  if (text === '' || key === '') return NO_MATCH;

  // Incomplete dishes carry no searchable fields and are never results.
  const dishes = completeDishes(menu);
  const dishIds = dishes
    .filter((dish) => matchesText(dish, text) || matchesChip(dish, key))
    .map((dish) => dish.dishId);

  // Shown even with no results: "no dishes found" for an allergen must not read as "free from".
  // NOTICE_KEYS covers P0 allergens, dietary values and common terms with or without matches; the
  // second check covers an allergen outside the P0 list that a dish on this menu lists.
  const allergyNotice =
    NOTICE_KEYS.has(key) ||
    dishes.some((dish) => dish.allergens.some((value) => allergenKeys(value).includes(key)));

  return { dishIds, allergyNotice };
}
