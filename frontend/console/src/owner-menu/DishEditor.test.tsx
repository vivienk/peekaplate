import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { DishFormView } from '../owner-dashboard/DishFormView';
import { DishEditor, type DishEditorProps } from './DishEditor';
import { dishFromReviewItem, emptyManualDish } from './dishForm';
import { evidenceExcerpts } from './evidence';
import { EXTRACTION_ID, reviewSession } from './fixtures.test-helpers';

const captured = vi.hoisted(() => ({
  props: null as ComponentProps<typeof DishFormView> | null,
  buttons: [] as ComponentProps<typeof import('../owner-dashboard/controls').Btn>[],
}));
vi.mock('../owner-dashboard/controls', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../owner-dashboard/controls')>();
  return {
    ...actual,
    Btn: (props: ComponentProps<typeof actual.Btn>) => {
      captured.buttons.push(props);
      return <actual.Btn {...props} />;
    },
  };
});
vi.mock('../owner-dashboard/DishFormView', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../owner-dashboard/DishFormView')>();
  return {
    ...actual,
    DishFormView: (props: ComponentProps<typeof DishFormView>) => {
      captured.props = props;
      return <actual.DishFormView {...props} />;
    },
  };
});

const noop = () => {};
const render = (props: Partial<DishEditorProps> = {}) =>
  renderToStaticMarkup(
    <DishEditor
      value={emptyManualDish()}
      onChange={noop}
      onSave={noop}
      onCancel={noop}
      {...props}
    />,
  );

describe('live Screen 9 on the authored #172 presentation', () => {
  it.each([{ items: [] }, { items: ['Carrot'] }])(
    'leaves review unchanged when ingredients add nothing: %j',
    async ({ items }) => {
      captured.buttons = [];
      const onChange = vi.fn();
      const suggestIngredients = vi.fn(async () => items);
      render({
        value: { ...emptyManualDish(), ingredients: { status: 'confirmed', items: ['Carrot'] } },
        reviewConfirmed: true,
        onChange,
        suggestIngredients,
      });
      captured.buttons
        .find((button) => button.children === 'Suggest with AI')!
        .onClick?.({} as never);
      await Promise.resolve();
      await Promise.resolve();
      expect(suggestIngredients).toHaveBeenCalledTimes(1);
      expect(onChange).not.toHaveBeenCalled();
    },
  );
  it('adds returned ingredients as proposed through the existing button and requires review', async () => {
    captured.buttons = [];
    const onChange = vi.fn();
    const onReviewConfirmedChange = vi.fn();
    render({
      value: { ...emptyManualDish(), ingredients: { status: 'confirmed', items: ['Carrot'] } },
      reviewConfirmed: true,
      onChange,
      onReviewConfirmedChange,
      suggestIngredients: async () => ['Carrot', 'Peas'],
    });
    captured.buttons
      .find((button) => button.children === 'Suggest with AI')!
      .onClick?.({} as never);
    await Promise.resolve();
    await Promise.resolve();
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        ingredients: { status: 'proposed', items: ['Carrot', 'Peas'] },
        aiIng: ['Peas'],
        aiUsed: true,
      }),
    );
    expect(onReviewConfirmedChange).toHaveBeenCalledWith(false);
  });

  it('connects the optional callbacks to the authored controls', () => {
    const suggestIngredients = vi.fn(async () => ['Carrot']);
    const suggestAllergens = vi.fn(async () => ['milk']);
    const draftDescription = vi.fn(async () => 'A proposed description.');
    const html = render({ suggestIngredients, suggestAllergens, draftDescription });
    expect(captured.props?.suggestIngredients).toBe(suggestIngredients);
    expect(captured.props?.suggestAllergens).toBe(suggestAllergens);
    expect(captured.props?.draftDescription).toBe(draftDescription);
    expect(html).not.toMatch(/<button[^>]+disabled=""[^>]*>Draft with AI/);
  });

  it('keeps suggested lists proposed and tagged across controlled rerenders and ingredient review', () => {
    const onChange = vi.fn();
    const value = emptyManualDish();
    render({ value, onChange });
    const props = captured.props!;
    props.setEd({
      ...props.ed,
      draft: {
        ...props.ed.draft,
        ing: ['Carrot'],
        alg: ['milk'],
        aiIng: ['Carrot'],
        aiAlg: ['milk'],
        aiUsed: true,
      },
    });
    const proposed = onChange.mock.lastCall![0];
    expect(proposed.ingredients).toEqual({ status: 'proposed', items: ['Carrot'] });
    expect(proposed.allergens).toEqual({ status: 'proposed', items: ['milk'] });
    const html = render({ value: proposed, onChange, onReviewConfirmedChange: noop });
    expect(captured.props!.ed.draft.aiIng).toEqual(['Carrot']);
    expect(captured.props!.ed.draft.aiAlg).toEqual(['milk']);
    expect(html).toContain('Suggested by AI');
    expect(html).toContain('Allergens not confirmed');
    const reviewed = captured.props!;
    reviewed.setEd({ ...reviewed.ed, draft: { ...reviewed.ed.draft, aiReviewed: true } });
    const accepted = onChange.mock.lastCall![0];
    expect(accepted.ingredients.status).toBe('confirmed');
    expect(accepted.allergens.status).toBe('proposed');
    render({ value: accepted, reviewConfirmed: true });
    expect(captured.props!.ed.draft.aiIng).toEqual([]);
    expect(captured.props!.ed.draft.aiAlg).toEqual(['milk']);
  });

  it('does not turn an empty suggestion into an allergen-free claim', () => {
    const onChange = vi.fn();
    render({ onChange });
    const props = captured.props!;
    props.setEd({ ...props.ed, draft: { ...props.ed.draft, aiUsed: true } });
    expect(onChange.mock.lastCall![0].allergens).toEqual({ status: 'unknown', items: [] });
  });

  it('retains a new AI suggestion while resetting an earlier review and keeps manual entries confirmed', () => {
    const onChange = vi.fn();
    const onReviewConfirmedChange = vi.fn();
    render({ onChange, onReviewConfirmedChange, reviewConfirmed: true });
    const props = captured.props!;
    props.setEd({
      ...props.ed,
      draft: {
        ...props.ed.draft,
        ing: ['Carrot'],
        aiIng: ['Carrot'],
        aiUsed: true,
        aiReviewed: false,
      },
    });
    expect(onChange.mock.lastCall![0].ingredients).toEqual({
      status: 'proposed',
      items: ['Carrot'],
    });
    expect(onReviewConfirmedChange).toHaveBeenCalledWith(false);
    render({ onChange });
    const manual = captured.props!;
    manual.setEd({ ...manual.ed, draft: { ...manual.ed.draft, ing: ['Leek'], alg: ['egg'] } });
    expect(onChange.mock.lastCall![0]).toMatchObject({
      ingredients: { status: 'confirmed', items: ['Leek'] },
      allergens: { status: 'confirmed', items: ['egg'] },
    });
  });
  it('renders a private actual 2.5D review image without claiming it is published', () => {
    const html = render({
      value: { ...emptyManualDish(), name: 'Garden Soup' },
      portionReview: { status: 'needs_review', previewUrl: 'blob:generated-cutout' },
    });
    expect(html).toContain('src="blob:generated-cutout"');
    expect(html).toContain('Review-only 2.5D preview of Garden Soup');
    expect(html).toContain('Needs review');
    expect(html).toContain('private until the menu is published');
    expect(html).not.toContain('Diners can tap');
  });

  it('requires a deliberate 2.5D approval and never labels a private asset public', () => {
    const pending = render({
      portionReview: { status: 'needs_review', previewUrl: 'blob:review-image' },
      onApprovePortion: noop,
    });
    expect(pending).toContain('Approve 2.5D preview');
    const approved = render({
      portionReview: {
        status: 'needs_review',
        previewUrl: 'blob:review-image',
        approved: true,
      },
      onApprovePortion: noop,
    });
    expect(approved).toContain('Approved for publication review');
    expect(approved).not.toContain('>Approve 2.5D preview</button>');
    expect(approved).toContain('private until the menu is published');
  });

  it('does not treat a source photo or pending generation as approved 2.5D', () => {
    const html = render({
      photoUrl: 'blob:private-photo',
      portionReview: { status: 'processing' },
    });
    expect(html).toContain('Preparing the 2.5D preview');
    expect(html).not.toContain('src="blob:generated-cutout"');
    const unavailable = render({ portionReview: { status: 'failed' } });
    expect(unavailable).toContain('original dish photo remains the View Portion fallback');
  });

  it('adds optional people served without replacing the authored serving-size text', () => {
    const html = render({
      value: { ...emptyManualDish(), servingSize: '1 bowl', servingCount: '2' },
    });
    expect(html).toMatch(/id="f-size"[^>]+value="1 bowl"/);
    expect(html).toContain('People served');
    expect(html).toMatch(/type="number"[^>]+min="1"[^>]+max="100"[^>]+step="1"/);
    expect(html).toMatch(/id="dish-serving-count"[^>]+value="2"/);
    const blank = render().match(/<input[^>]+id="dish-serving-count"[^>]*>/)?.[0] ?? '';
    expect(blank).toContain('value=""');
    expect(blank).not.toContain('required');
  });

  it('keeps OCR evidence, actual CAD currency and unknown allergens on the authored form', () => {
    const session = reviewSession();
    const item = session.items[0]!;
    const html = render({
      existing: true,
      value: dishFromReviewItem(EXTRACTION_ID, item),
      evidence: evidenceExcerpts(session, item),
    });
    expect(html).toContain('Edit dish');
    expect(html).toContain('s09-grid');
    expect(html).toContain('Price (CAD)');
    expect(html).toContain('Printed on the menu: 8.50 / 12.50 CAD');
    expect(html).toContain('From the menu');
    expect(html).toContain('Garden Soup - vegetables - 8.50 / 12.50 CAD');
    expect(html).toContain('Diners will see: Allergens not confirmed.');
    expect(html).toContain('For allergy questions, please ask the restaurant staff.');
    expect(html).not.toContain('USD pilot default');
  });
  it('uses the authored text allergen entry, enabled serving field and Back / Continue actions', () => {
    const html = render();
    expect(html).toContain('id="f-alg"');
    expect(html).toMatch(/<input[^>]+required=""[^>]+id="f-size"/);
    expect(html).not.toMatch(/<input[^>]+disabled[^>]+id="f-size"/);
    expect(html).not.toContain('role="radiogroup"');
    expect(html).toContain('>Back</button>');
    expect(html).toContain('Continue to review');
    expect(html).not.toContain('From the menu');
  });
  it('keeps AI controls visible but disabled when no real drafting API exists', () => {
    const html = render();
    expect(html).toMatch(/<button[^>]+disabled=""[^>]*>Shorten description with AI/);
    expect(html).toContain('AI suggestions are not connected yet');
    expect(html).not.toContain('Seasonal vegetables');
  });
  it('preserves confirmed allergens and uses the USD pilot default without a raw currency field', () => {
    const value = emptyManualDish();
    value.allergens = { status: 'confirmed', items: ['milk', 'wheat'] };
    const html = render({ value });
    expect(html).toContain('Contains: milk, wheat');
    expect(html).toContain('Price (USD)');
    expect(html).not.toContain('id="dish-currency"');
    expect(html).not.toContain('Currency code');
    const item = reviewSession().items[0]!;
    item.effective.price_currency = null;
    expect(render({ value: dishFromReviewItem(EXTRACTION_ID, item) })).toContain(
      'Currency was not read from the menu. Prices use the USD pilot default.',
    );
  });
  it('keeps rights with the photo and gates continuation on both attestations', () => {
    const value = { ...emptyManualDish(), photoId: '00000000-0000-4000-8000-000000000111' };
    const props = {
      value,
      photoUrl: 'blob:private-photo',
      onReviewConfirmedChange: noop,
      onLicenseConfirmedChange: noop,
    };
    const button = (html: string) =>
      html.match(/<button[^>]*>Continue to review<\/button>/)?.[0] ?? '';
    expect(render(props)).toContain('I have the right to use this photo.');
    expect(button(render({ ...props, reviewConfirmed: true }))).toContain('disabled');
    expect(button(render({ ...props, licenseConfirmed: true }))).toContain('disabled');
    expect(
      button(render({ ...props, reviewConfirmed: true, licenseConfirmed: true })),
    ).not.toContain(' disabled=""');
  });
  it('disables editable descendants while an existing save is running', () => {
    expect(render({ busy: true })).toContain('<fieldset disabled=""');
  });
});
