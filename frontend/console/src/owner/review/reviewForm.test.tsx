import { describe, expect, it } from 'vitest';
import { emptyManualDish } from '../../owner-menu/dishForm';
import { confirmedCalibration } from '../../owner-menu/portionCalibration.test-helpers';
import { dishStatus, type ReviewDish } from './reviewDishes';
import { dishToForm, formToDish } from './reviewForm';

const dish = (over: Partial<ReviewDish> = {}): ReviewDish => ({
  id: 'd1',
  name: 'Avocado Toast',
  category: 'Breakfast',
  description: 'Toasted bread with smashed avocado and a poached egg.',
  priceAmount: '14',
  ingredients: { status: 'confirmed', items: ['Bread', 'Avocado', 'Egg'] },
  allergens: { status: 'confirmed', items: ['egg', 'wheat'] },
  photoId: 'photo-1',
  servingSize: '1 serving',
  priceCurrency: 'USD',
  ...over,
});

describe('S10 row to S09 form values', () => {
  it('round-trips explicit photo calibration without inventing it for legacy serving labels', () => {
    const previous = dish({ servingSize: '28 cm', portionCalibration: confirmedCalibration });
    const form = dishToForm(previous);
    expect(form.portionCalibration).toEqual(confirmedCalibration);
    expect(formToDish(form, previous.id, previous)).toEqual(previous);
    expect(formToDish({ ...form, portionCalibration: null }, previous.id, previous)).toHaveProperty(
      'portionCalibration',
      null,
    );
    expect(dishToForm(dish())).not.toHaveProperty('portionCalibration');
  });

  it('round-trips people served separately from the descriptive serving size', () => {
    const previous = dish({ servingSize: '1 bowl', servingCount: 2 });
    const form = dishToForm(previous);
    expect(form.servingSize).toBe('1 bowl');
    expect(form.servingCount).toBe('2');
    expect(formToDish(form, previous.id, previous)).toEqual(previous);
  });

  it('never infers people served from a numeric serving label', () => {
    const previous = dish({ servingSize: '2' });
    const form = dishToForm(previous);
    expect(form.servingCount).toBeUndefined();
    expect(formToDish(form, previous.id, previous)).toEqual(previous);
  });

  it('keeps a blank count unknown and rejects counts outside whole people from 1 to 100', () => {
    expect(formToDish({ ...emptyManualDish(), servingCount: '' }, 'd1').servingCount).toBeNull();
    for (const servingCount of ['0', '-1', '1.5', '101'])
      expect(() => formToDish({ ...emptyManualDish(), servingCount }, 'd1')).toThrow();
  });

  it('opens the form with exactly what S10 shows, and keeps each status', () => {
    const form = dishToForm(dish());
    expect(form).toMatchObject({
      origin: 'manual',
      name: 'Avocado Toast',
      category: 'Breakfast',
      priceAmount: '14',
      priceCurrency: 'USD',
      photoId: 'photo-1',
    });
    expect(form.ingredients).toEqual({ status: 'confirmed', items: ['Bread', 'Avocado', 'Egg'] });
    expect(form.allergens).toEqual({ status: 'confirmed', items: ['egg', 'wheat'] });
  });

  it('shows missing values as empty fields, and unknown stays unknown', () => {
    const form = dishToForm(
      dish({
        category: null,
        priceAmount: null,
        description: null,
        allergens: { status: 'unknown', items: [] },
      }),
    );
    expect(form.category).toBe('');
    expect(form.priceAmount).toBe('');
    expect(form.description).toBe('');
    expect(form.allergens).toEqual({ status: 'unknown', items: [] });
  });
});

describe('S09 form values back to an S10 row', () => {
  it('turns blank fields into missing values, so S10 shows what is still missing', () => {
    const saved = formToDish({ ...emptyManualDish(), name: 'Soup' }, 'new-1');
    expect(saved).toMatchObject({ id: 'new-1', name: 'Soup', category: null, priceAmount: null });
    expect(dishStatus(saved).ready).toBe(false);
  });

  it('never makes unknown or proposed facts confirmed', () => {
    const form = {
      ...emptyManualDish(),
      ingredients: { status: 'proposed' as const, items: ['Rice'] },
    };
    const saved = formToDish(form, 'new-2');
    expect(saved.ingredients.status).toBe('proposed');
    expect(saved.allergens).toEqual({ status: 'unknown', items: [] });
  });

  it('keeps the serving size and currency of the dish being edited', () => {
    const previous = dish();
    const saved = formToDish(
      { ...dishToForm(previous), name: 'Avocado Toast Deluxe' },
      'd1',
      previous,
    );
    expect(saved.name).toBe('Avocado Toast Deluxe');
    expect(saved.servingSize).toBe('1 serving');
    expect(saved.priceCurrency).toBe('USD');
  });

  it('a complete dish round-trips unchanged and is Ready', () => {
    const previous = dish();
    const saved = formToDish(dishToForm(previous), previous.id, previous);
    expect(saved).toEqual(previous);
    expect(dishStatus(saved).ready).toBe(true);
  });
});
