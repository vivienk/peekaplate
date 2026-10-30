// Synthetic fixtures for S3-DIN-01.1. Dish names follow Rania's Figma frames; every value is
// invented test data, not an approved restaurant menu, and images are labelled placeholders, not
// food photos. Allergens use the approved P0 code values; the adapter turns them into labels.
import { toMenu } from './adapter';
import type { MenuLoadResult, MenuSource } from './types';
import type { WireCompleteDish, WireDish, WireImage, WireMenuBundle } from './wire';

export const FIXTURE_PUBLICATION_REVISION_ID = 'a5000000-0000-4000-8000-000000000001';

const id = (prefix: string, n: number) =>
  `${prefix}000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const CATEGORY = {
  breakfast: id('a4', 1),
  brunchBowls: id('a4', 2),
  salads: id('a4', 3),
} as const;

export const DISH = {
  avocadoToast: id('a1', 1),
  harvestPowerBowl: id('a1', 2),
  eggsBenedict: id('a1', 3),
  gardenAvocadoSalad: id('a1', 4),
  berryPancakeStack: id('a1', 5),
  salmonPokeBowl: id('a1', 6),
  briocheFrenchToast: id('a1', 7),
  longName: id('a1', 8),
  incomplete: id('a1', 9),
  noIngredients: id('a1', 10),
  noAllergenData: id('a1', 11),
} as const;

// Every P0 allergen has an icon, so the no-icon case is a validated value outside the P0 list.
export const NO_ICON_ALLERGEN = 'Mustard';
export const NO_ICON_INGREDIENT = 'House sauce';

function placeholderImage(label: string): WireImage {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640"><rect width="640" height="640" fill="#3a3d45"/><text x="320" y="320" fill="#c9cbd1" font-family="sans-serif" font-size="28" text-anchor="middle">Fixture photo</text></svg>`;
  return {
    url: `data:image/svg+xml,${encodeURIComponent(svg)}`,
    width: 640,
    height: 640,
    alt: `Placeholder image for ${label} (synthetic fixture)`,
  };
}

let ingredientCounter = 0;
function dish(
  n: number,
  fields: Omit<WireCompleteDish, 'dish_id' | 'dish_revision_id' | 'complete' | 'ingredients'> & {
    ingredients: string[];
  },
): WireCompleteDish {
  return {
    dish_id: id('a1', n),
    dish_revision_id: id('a2', n),
    complete: true,
    ...fields,
    ingredients: fields.ingredients.map((name) => ({
      ingredient_id: id('a3', ++ingredientCounter),
      name,
      description: null,
    })),
  };
}

const images = (label: string) => ({
  card: placeholderImage(label),
  detail: placeholderImage(label),
});
const usd = (amount: string) => ({ amount, currency: 'USD' });

// Five coherent dishes for the end-to-end demo journey.
const avocadoToast = dish(1, {
  name: 'Avocado Toast',
  description:
    'Smashed avocado on toasted sourdough with a poached egg, cherry tomatoes and greens.',
  price: usd('14.00'),
  ingredients: ['Sourdough bread', 'Avocado', 'Poached egg', 'Cherry tomatoes', 'Microgreens'],
  allergens: ['wheat', 'egg'],
  dietary: ['Vegetarian'],
  images: images('Avocado Toast'),
});
const harvestPowerBowl = dish(2, {
  name: 'Harvest Power Bowl',
  description: 'Quinoa with grilled chicken, roasted sweet potato, avocado, kale and red cabbage.',
  price: usd('18.00'),
  ingredients: ['Quinoa', 'Grilled chicken', 'Roasted sweet potato', 'Avocado', 'Kale'],
  allergens: [],
  dietary: ['Gluten-free'],
  images: images('Harvest Power Bowl'),
});
const eggsBenedict = dish(3, {
  name: 'Classic Eggs Benedict',
  description:
    'Poached eggs and ham on toasted English muffins, finished with warm hollandaise and chives.',
  price: usd('16.00'),
  ingredients: [
    'English muffin',
    'Ham',
    'Poached egg',
    'Hollandaise',
    'Chives',
    NO_ICON_INGREDIENT,
  ],
  allergens: ['milk', 'egg', 'wheat'],
  dietary: [],
  images: images('Classic Eggs Benedict'),
});

// Edge cases listed in the DIN-01 ticket.
const manyChips = dish(4, {
  name: 'Garden Avocado Salad',
  description: 'Mixed leaves, avocado and walnuts with peanut dressing and sesame tofu croutons.',
  price: usd('13.00'),
  ingredients: ['Mixed leaves', 'Avocado', 'Walnuts', 'Peanut dressing', 'Tofu croutons'],
  allergens: ['tree nut', 'peanut', 'soy', 'sesame', NO_ICON_ALLERGEN],
  dietary: ['Vegan', 'Vegetarian'],
  images: images('Garden Avocado Salad'),
});
// The ticket's conflict case, reworded to Wheat with Gluten-free now the P0 list is approved.
const glutenConflict = dish(5, {
  name: 'Berry Pancake Stack',
  description: 'Buttermilk pancakes with mixed berries and maple syrup.',
  price: usd('15.00'),
  ingredients: ['Buttermilk pancakes', 'Mixed berries', 'Maple syrup', 'Butter'],
  allergens: ['wheat', 'milk', 'egg'],
  dietary: ['Vegetarian', 'Gluten-free'],
  images: images('Berry Pancake Stack'),
});
const salmonPokeBowl = dish(6, {
  name: 'Salmon Poke Bowl',
  description: 'Marinated salmon over sushi rice with edamame, cucumber and pickled ginger.',
  price: usd('19.00'),
  ingredients: ['Salmon', 'Sushi rice', 'Edamame', 'Cucumber', 'Pickled ginger'],
  allergens: ['fish', 'soy', 'sesame'],
  dietary: [],
  images: images('Salmon Poke Bowl'),
});
const missingImage = dish(7, {
  name: 'Brioche French Toast',
  description: 'Thick brioche slices with cinnamon custard and whipped cream.',
  price: usd('16.00'),
  ingredients: ['Brioche', 'Egg custard', 'Cinnamon', 'Whipped cream'],
  allergens: ['wheat', 'egg', 'milk'],
  dietary: ['Vegetarian'],
  images: null,
});
const longName = dish(8, {
  name: 'Slow-Roasted Heirloom Tomato and Burrata Salad with Basil Oil and Toasted Sourdough Crumbs',
  description:
    'Heirloom tomatoes roasted for three hours, creamy burrata, basil oil, flaky salt and toasted sourdough crumbs, served with a small side of dressed rocket leaves.',
  price: usd('17.50'),
  ingredients: ['Heirloom tomatoes', 'Burrata', 'Basil oil', 'Sourdough crumbs', 'Rocket'],
  allergens: ['milk', 'wheat'],
  dietary: ['Vegetarian'],
  images: images('Heirloom Tomato and Burrata Salad'),
});
// No validated allergen or dietary data, so the detail screen hides the whole section.
const noAllergenData = dish(11, {
  name: 'Fresh Fruit Cup',
  description: 'Seasonal melon, pineapple and berries.',
  price: usd('8.00'),
  ingredients: ['Melon', 'Pineapple', 'Mixed berries'],
  allergens: [],
  dietary: [],
  images: images('Fresh Fruit Cup'),
});

// Draft-like fields the adapter must drop at every level; the value marks any leak in tests.
export const DRAFT_MARKER = 'DRAFT-ONLY';
const withDraftFields = (d: WireCompleteDish): WireDish =>
  Object.assign({}, d, {
    draft_notes: DRAFT_MARKER,
    ocr_confidence: 0.42,
    internal_cost: DRAFT_MARKER,
    price: { ...d.price, cost_basis: DRAFT_MARKER },
    ingredients: d.ingredients.map((i) => ({ ...i, supplier: DRAFT_MARKER })),
    images: d.images && {
      card: { ...d.images.card, source_file: DRAFT_MARKER },
      detail: { ...d.images.detail, source_file: DRAFT_MARKER },
    },
  });
const longNameWithDrafts = withDraftFields(longName);
const incomplete: WireDish = {
  dish_id: DISH.incomplete,
  dish_revision_id: id('a2', 9),
  complete: false,
};
const noIngredients = dish(10, {
  name: 'Seasonal Green Salad',
  description: 'Draft description awaiting restaurant input.',
  price: usd('12.00'),
  ingredients: [],
  allergens: [],
  dietary: [],
  images: images('Seasonal Green Salad'),
});

function bundle(
  revision: number,
  categories: { breakfast: WireDish[]; brunchBowls: WireDish[]; salads: WireDish[] },
): WireMenuBundle {
  const restaurant = { name: 'Ember & Stone', logo: null, internal_code: DRAFT_MARKER };
  return {
    schema_version: 1,
    venue_id: id('a6', 1),
    menu_id: id('a7', 1),
    menu_revision_id: id('a8', revision),
    restaurant,
    categories: [
      { category_id: CATEGORY.breakfast, name: 'Breakfast', dishes: categories.breakfast },
      { category_id: CATEGORY.brunchBowls, name: 'Brunch Bowls', dishes: categories.brunchBowls },
      { category_id: CATEGORY.salads, name: 'Salads', dishes: categories.salads },
    ],
  };
}

export const demoBundle = bundle(1, {
  breakfast: [avocadoToast, eggsBenedict],
  brunchBowls: [harvestPowerBowl, salmonPokeBowl],
  salads: [manyChips],
});

export const edgeCaseBundle = bundle(2, {
  breakfast: [avocadoToast, eggsBenedict, glutenConflict, missingImage, noAllergenData],
  brunchBowls: [harvestPowerBowl, salmonPokeBowl, incomplete],
  salads: [manyChips, longNameWithDrafts, noIngredients],
});

// The same menu after an update that withdraws the Salmon Poke Bowl.
export const edgeCaseAfterWithdrawalBundle = bundle(3, {
  breakfast: [avocadoToast, eggsBenedict, glutenConflict, missingImage, noAllergenData],
  brunchBowls: [harvestPowerBowl, incomplete],
  salads: [manyChips, longNameWithDrafts, noIngredients],
});

const layoutCategories = { breakfast: [], brunchBowls: [], salads: [] } as {
  [K in 'breakfast' | 'brunchBowls' | 'salads']: WireDish[];
};
const layoutKeys = ['breakfast', 'brunchBowls', 'salads'] as const;
for (let n = 1; n <= 20; n++) {
  layoutCategories[layoutKeys[(n - 1) % 3] ?? 'breakfast'].push(
    dish(100 + n, {
      name: `Layout sample dish ${n}`,
      description: 'Layout-only fixture text.',
      price: usd(`${10 + n}.00`),
      ingredients: ['Sample ingredient'],
      allergens: [],
      dietary: [],
      images: images(`Layout sample dish ${n}`),
    }),
  );
}
export const layoutBundle = bundle(4, layoutCategories);

export const emptyBundle = bundle(5, { breakfast: [], brunchBowls: [], salads: [] });

export type FixtureScenario =
  | 'demo'
  | 'edge-cases'
  | 'withdrawal'
  | 'layout-20'
  | 'empty'
  | 'unavailable'
  | 'error'
  | 'offline';

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

// `delayMs` simulates a slow network for the loading state. The "withdrawal" scenario returns the
// edge-case menu first and the updated menu on every later load.
export function createFixtureMenuSource(
  scenario: FixtureScenario,
  options: { delayMs?: number } = {},
): MenuSource {
  let loads = 0;
  return {
    async load(signal) {
      await wait(options.delayMs ?? 0, signal);
      loads++;
      const ready = (b: WireMenuBundle): MenuLoadResult =>
        toMenu(b, 'fixture', FIXTURE_PUBLICATION_REVISION_ID);
      switch (scenario) {
        case 'demo':
          return ready(demoBundle);
        case 'edge-cases':
          return ready(edgeCaseBundle);
        case 'withdrawal':
          return ready(loads === 1 ? edgeCaseBundle : edgeCaseAfterWithdrawalBundle);
        case 'layout-20':
          return ready(layoutBundle);
        case 'empty':
          return ready(emptyBundle);
        default:
          return { status: scenario };
      }
    },
  };
}
