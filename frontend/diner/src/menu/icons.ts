// Display icons from Rania's Figma exports (shared by Amr, Nov 3). Icons are decoration only:
// screens always show the text label next to them and mark the image alt="" / aria-hidden, so a
// missing icon never hides information. Allergen and dietary icons are keyed by the approved
// values in ./types; ingredient icons by ingredient name, because the bundle has no icon field.

import generatedCatalogue from '../assets/icons/generated-ingredients/catalogue.json';
import heart from '../assets/icons/ui/heart.svg';
import search from '../assets/icons/ui/search.svg';
import { ALLERGENS, DIETARY_VALUES, LEGACY_ALLERGEN_CODES } from './types';

type UrlModules = Record<string, string>;
const glob = {
  allergens: import.meta.glob<string>('../assets/icons/allergens/*.svg', {
    eager: true,
    query: '?url',
    import: 'default',
  }),
  dietary: import.meta.glob<string>('../assets/icons/dietary/*.svg', {
    eager: true,
    query: '?url',
    import: 'default',
  }),
  ingredients: import.meta.glob<string>('../assets/icons/ingredients/*.svg', {
    eager: true,
    query: '?url',
    import: 'default',
  }),
  generated: import.meta.glob<string>('../assets/icons/generated-ingredients/*.{png,webp}', {
    eager: true,
    query: '?url',
    import: 'default',
  }),
};

// File names are lower-case words joined by hyphens: "Cherry tomato" -> cherry-tomato.svg.
export const iconKey = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

function byKey(modules: UrlModules): ReadonlyMap<string, string> {
  return new Map(
    Object.entries(modules).map(([path, url]) => [path.replace(/^.*\/|\.svg$/g, ''), url]),
  );
}
const allergenIcons = byKey(glob.allergens);
const dietaryIcons = byKey(glob.dietary);
const ingredientIcons = byKey(glob.ingredients);

export const UI_ICONS = { heart, search } as const;

// Accepts the label screens show ("Nuts"), the code ("nuts") or a legacy code ("tree nut").
export function allergenIcon(value: string): string | null {
  const v = value.trim().toLowerCase();
  const code =
    LEGACY_ALLERGEN_CODES[v] ??
    ALLERGENS.find((a) => a.code === v || a.label.toLowerCase() === v)?.code;
  return code ? (allergenIcons.get(iconKey(code)) ?? null) : null;
}

export function dietaryIcon(value: string): string | null {
  const known = DIETARY_VALUES.find((d) => d.toLowerCase() === value.trim().toLowerCase());
  return known ? (dietaryIcons.get(iconKey(known)) ?? null) : null;
}

// Exact name match only (case and spacing ignored): a guess could show the wrong food.
export function ingredientIcon(name: string): string | null {
  return (
    ingredientIcons.get(iconKey(name)) ??
    generatedIngredientIcon(name, generatedCatalogue, glob.generated)
  );
}

// Only the reviewed build catalogue can supply artwork. Never accept remote URLs
// or extraction drafts from a menu bundle; artwork does not establish food facts.
export function generatedIngredientIcon(
  name: string,
  catalogue: Readonly<Record<string, string>>,
  modules: UrlModules,
): string | null {
  const label = name.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!Object.hasOwn(catalogue, label)) return null;
  const file = catalogue[label];
  if (!file || !/^[a-f0-9]{64}\.(png|webp)$/.test(file)) return null;
  return modules[`../assets/icons/generated-ingredients/${file}`] ?? null;
}
