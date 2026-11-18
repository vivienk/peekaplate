// Connects S10 (Menu Review) to the S09 Add/Edit dish form (owner-menu/DishEditor, FE-06.2). Both
// sides use the same draft fields (OwnerDishFields), so nothing is converted or invented here:
// blank text becomes missing (null), and an unknown, proposed or confirmed status is kept as it is.
// The people count uses its canonical field; legacy notes and plate calibration remain separate.
import type { AllergenCode, DishForm } from '../../owner-menu/dishForm';
import { servingCountText, servingCountValue } from '../../owner-menu/servingCount';
import type { ReviewDish } from './reviewDishes';

const ALLERGEN_CODES: ReadonlySet<string> = new Set<AllergenCode>([
  'milk',
  'egg',
  'fish',
  'crustacean shellfish',
  'nuts',
  'peanut',
  'wheat',
  'soy',
  'sesame',
]);

const orNull = (value: string): string | null => (value.trim() === '' ? null : value.trim());

/** The S09 form opened from Edit: the dish exactly as S10 shows it. */
export function dishToForm(dish: ReviewDish): DishForm {
  const count = servingCountText(dish.servingCount, dish.servingSize, dish.portionCalibration);
  return {
    origin: 'manual',
    servingSize: dish.servingSize ?? '',
    name: dish.name ?? '',
    category: dish.category ?? '',
    description: dish.description ?? '',
    priceAmount: dish.priceAmount ?? '',
    priceCurrency: dish.priceCurrency ?? '',
    ...(dish.servingCount !== undefined || count !== '' ? { servingCount: count } : {}),
    ...(dish.portionCalibration !== undefined
      ? { portionCalibration: dish.portionCalibration }
      : {}),
    ingredients: { status: dish.ingredients.status, items: [...dish.ingredients.items] },
    allergens: {
      status: dish.allergens.status,
      items: dish.allergens.items.filter((item): item is AllergenCode => ALLERGEN_CODES.has(item)),
    },
    photoId: dish.photoId,
    source: null,
  };
}

/**
 * The dish S10 shows after Continue in S09. `previous` is the dish being edited (undefined for a
 * new dish). The form can leave fields incomplete; S10 then shows what is still missing.
 */
export function formToDish(form: DishForm, id: string, previous?: ReviewDish): ReviewDish {
  const dish: ReviewDish = {
    id,
    name: orNull(form.name),
    category: orNull(form.category),
    description: orNull(form.description),
    priceAmount: orNull(form.priceAmount),
    ingredients: { status: form.ingredients.status, items: [...form.ingredients.items] },
    allergens: { status: form.allergens.status, items: [...form.allergens.items] },
    photoId: form.photoId,
  };
  const priceCurrency = orNull(form.priceCurrency) ?? previous?.priceCurrency;
  if (priceCurrency !== undefined) dish.priceCurrency = priceCurrency;
  dish.servingSize = orNull(form.servingSize);
  if (form.servingCount !== undefined) {
    dish.servingCount = servingCountValue(form.servingCount);
  } else if (previous?.servingCount !== undefined) dish.servingCount = previous.servingCount;
  if (form.portionCalibration !== undefined) dish.portionCalibration = form.portionCalibration;
  else if (previous?.portionCalibration !== undefined)
    dish.portionCalibration = previous.portionCalibration;
  return dish;
}
