import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DishEditor } from './DishEditor';
import { dishFromReviewItem, emptyManualDish } from './dishForm';
import { evidenceExcerpts } from './evidence';
import { EXTRACTION_ID, reviewSession } from './fixtures.test-helpers';

const noop = () => {};

function scanned() {
  const session = reviewSession();
  const item = session.items[0];
  if (!item) throw new Error('fixture has no candidates');
  return {
    form: dishFromReviewItem(EXTRACTION_ID, item),
    evidence: evidenceExcerpts(session, item),
  };
}

describe('DishEditor (Screen 9)', () => {
  it('shows a scanned dish with its menu source, printed price and unknown allergens', () => {
    const { form, evidence } = scanned();
    const html = renderToStaticMarkup(
      <DishEditor
        value={form}
        evidence={evidence}
        onChange={noop}
        onSave={noop}
        onVerify={noop}
        onCancel={noop}
      />,
    );
    expect(html).toContain('Review scanned dish');
    expect(html).toContain('value="Garden Soup"');
    expect(html).toContain('Printed on the menu: 8.50 / 12.50 CAD');
    expect(html).toContain('From the menu');
    expect(html).toContain('Garden Soup - vegetables - 8.50 / 12.50 CAD');
    // Scanned dishes cannot carry allergens yet, so there are no allergen checkboxes to tick.
    expect(html).toContain('cannot be saved on a scanned dish yet');
    expect(html).not.toContain('type="checkbox"');
    expect(html).toContain('Diners will see: Allergens not confirmed.');
    expect(html).toContain('For allergy questions, please ask the restaurant staff.');
  });

  it('lets a manual dish set allergen status, with the boxes off while unknown', () => {
    const html = renderToStaticMarkup(
      <DishEditor value={emptyManualDish()} onChange={noop} onSave={noop} onCancel={noop} />,
    );
    expect(html).toContain('Add dish');
    expect((html.match(/type="checkbox"/g) ?? []).length).toBe(9);
    expect((html.match(/type="checkbox" disabled=""/g) ?? []).length).toBe(9);
    expect(html).toContain('Not known yet');
    expect(html).toContain('Confirmed by me');
    expect(html).not.toContain('From the menu');
  });

  it('enables the allergen boxes once a status is chosen and states what diners will see', () => {
    const form = emptyManualDish();
    form.allergens = { status: 'confirmed', items: ['milk', 'wheat'] };
    const html = renderToStaticMarkup(
      <DishEditor value={form} onChange={noop} onSave={noop} onCancel={noop} />,
    );
    expect(html).not.toContain('disabled=""');
    expect(html).toContain('Diners will see: Contains: milk, wheat.');
  });

  it('never offers AI drafting and says verifying does not publish', () => {
    const { form, evidence } = scanned();
    const html = renderToStaticMarkup(
      <DishEditor
        value={form}
        evidence={evidence}
        onChange={noop}
        onSave={noop}
        onVerify={noop}
        onCancel={noop}
      />,
    );
    expect(html).not.toMatch(/AI/);
    expect(html).toContain('Verifying a dish does not publish your menu.');
    expect(html).toContain('Verify dish');
  });

  it('hides Verify when the parent cannot approve this dish', () => {
    const html = renderToStaticMarkup(
      <DishEditor value={emptyManualDish()} onChange={noop} onSave={noop} onCancel={noop} />,
    );
    expect(html).not.toContain('Verify dish');
    expect(html).toContain('Save draft');
  });
});
