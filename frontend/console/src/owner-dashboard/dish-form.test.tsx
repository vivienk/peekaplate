import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { initialMenu, newDraft } from './data';
import type { DishFields } from './dish-fields';
import { DishForm } from './dish-form';
import { fromFields, toFields } from './menu';

const noop = () => {};
const ocr: DishFields = {
  name: 'Fictional soup',
  category: 'Soups',
  description: null,
  priceAmount: '8.50',
  priceCurrency: 'CAD',
  ingredients: { status: 'proposed', items: ['Carrot', 'Onion'] },
  allergens: { status: 'unknown', items: [] },
  photoId: null,
};
const render = (props: Partial<Parameters<typeof DishForm>[0]> = {}) =>
  renderToStaticMarkup(
    <DishForm
      value={ocr}
      onChange={noop}
      onSave={noop}
      onCancel={noop}
      mode="add"
      categories={['Breakfast', 'Salads']}
      {...props}
    />,
  );

describe('DishForm (shared Add/Edit Dish, Screen 9)', () => {
  it('shows the dish it is given, including a category and currency from the draft', () => {
    const html = render();
    expect(html).toContain('value="Fictional soup"');
    expect(html).toContain('<option selected="">Soups</option>');
    expect(html).toContain('Price (CAD)');
    expect(html).toContain('Carrot');
    expect(html).toContain('<h1>Fictional soup</h1>');
  });

  it('asks the owner to check suggested ingredients and keeps unknown allergens unknown', () => {
    const html = render();
    expect(html).toMatch(/id="f-ing-ok" type="checkbox"(?! checked)/);
    expect(html).toMatch(/id="f-alg-unknown" type="radio" name="f-alg" checked/);
    expect(html).toContain('Diners will see: Allergens not confirmed yet. Ask staff.');
    expect(html).not.toContain('none of the 9');
  });

  it('shows API state: disabled buttons while saving, and the save error', () => {
    const html = render({ saving: true, error: 'Could not save. Try again.' });
    expect(html).toContain('aria-busy="true"');
    expect(html).toMatch(/type="submit"[^>]*disabled/);
    expect(html).toContain('Could not save. Try again.');
  });

  it('shows Save draft and the upload button only when the caller handles them', () => {
    expect(render()).not.toContain('Save draft');
    expect(render()).not.toContain('Upload photo');
    const html = render({ onSaveDraft: noop, onPhotoSelect: noop });
    expect(html).toContain('Save draft');
    expect(html).toContain('Upload photo');
  });
});

describe('demo adapter (#105 sample dishes through the shared form)', () => {
  it('round-trips a sample dish without losing demo-only parts', () => {
    const dish = initialMenu()[0];
    if (!dish) throw new Error('no sample dish');
    const back = fromFields(toFields(dish), dish);
    expect({ ...back, price: Number(back.price) }).toEqual(dish);
    expect(toFields(dish).allergens).toEqual({ status: 'unknown', items: [] });
  });

  it('maps a new demo draft to an empty API-shaped draft', () => {
    const f = toFields(newDraft());
    expect(f.priceAmount).toBeNull();
    expect(f.ingredients).toEqual({ status: 'unknown', items: [] });
  });
});
