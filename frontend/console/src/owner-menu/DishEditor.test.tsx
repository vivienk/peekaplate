import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { DishFormView } from '../owner-dashboard/DishFormView';
import { DishEditor, type DishEditorProps } from './DishEditor';
import { dishFromReviewItem, emptyManualDish } from './dishForm';
import { evidenceExcerpts } from './evidence';
import { EXTRACTION_ID, reviewSession } from './fixtures.test-helpers';
import { calibrationPhotoId, confirmedCalibration } from './portionCalibration.test-helpers';

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
  it('confirms only the matching saved original and does not require a people count', () => {
    const value = {
      ...emptyManualDish(),
      servingSize: '28',
      photoId: calibrationPhotoId,
      portionCalibration: confirmedCalibration,
    };
    const calibrationPhoto = {
      photoId: calibrationPhotoId,
      url: 'blob:reopened-original',
      source_sha256: confirmedCalibration.source_sha256,
      source_width_px: confirmedCalibration.source_width_px,
      source_height_px: confirmedCalibration.source_height_px,
    };
    const confirmation = (html: string) =>
      html.match(/<input[^>]+id="dish-portion-confirm"[^>]*>/)?.[0] ?? '';
    const saved = confirmation(render({ value, calibrationPhoto }));
    expect(saved).toContain('checked=""');
    expect(saved).not.toContain('disabled');
    const unknown = confirmation(
      render({ value: { ...value, portionCalibration: undefined }, calibrationPhoto }),
    );
    expect(unknown).not.toContain('checked');
    expect(unknown).toContain('disabled');
    const pendingHtml = render({ value, calibrationPhoto, photoPending: true });
    const pending = confirmation(pendingHtml);
    expect(pending).not.toContain('checked');
    expect(pending).toContain('disabled');
    expect(pendingHtml.match(/<input[^>]+id="dish-plate-size"[^>]*>/)?.[0]).toContain('disabled');
    const loading = render({ value });
    expect(loading.match(/<input[^>]+id="dish-plate-size"[^>]*>/)?.[0]).toContain('disabled');
    const other = confirmation(
      render({ value, calibrationPhoto: { ...calibrationPhoto, source_sha256: 'b'.repeat(64) } }),
    );
    expect(other).not.toContain('checked');
    const legacy = confirmation(
      render({ value: { ...value, servingSize: '1 bowl' }, calibrationPhoto }),
    );
    expect(legacy).toContain('checked');
    expect(legacy).not.toContain('disabled');
  });

  it('keeps legacy descriptive text out of both the people and plate measurement inputs', () => {
    const html = render({ value: { ...emptyManualDish(), servingSize: '1 bowl' } });
    expect(html).toContain('Serving size (people)');
    expect(html).toMatch(/id="f-size"[^>]+value=""/);
    expect(html).toMatch(/id="dish-plate-size"[^>]+value=""/);
    expect(html).toContain('Approximate until you confirm the measurements on the saved photo.');
    expect(html).not.toMatch(/type="checkbox"[^>]+checked=""/);
  });

  it('clears measurement confirmation when the serving-size people input changes', () => {
    const onChange = vi.fn();
    render({
      value: {
        ...emptyManualDish(),
        servingSize: '1',
        servingCount: '1',
        photoId: calibrationPhotoId,
        portionCalibration: confirmedCalibration,
      },
      onChange,
    });
    const props = captured.props!;
    if (props.ed.step !== 'form') throw new Error('expected authored form');
    props.setEd({ ...props.ed, draft: { ...props.ed.draft, size: '2' } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ servingSize: '2', servingCount: '2', portionCalibration: null }),
    );
  });

  it('keeps legacy serving text on unrelated edits without dropping the canonical people count', () => {
    const onChange = vi.fn();
    render({
      value: {
        ...emptyManualDish(),
        servingSize: '1 bowl',
        servingCount: '2',
        photoId: calibrationPhotoId,
        portionCalibration: confirmedCalibration,
      },
      onChange,
    });
    const props = captured.props!;
    props.setEd({ ...props.ed, draft: { ...props.ed.draft, name: 'Renamed dish' } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        servingSize: '1 bowl',
        servingCount: '2',
        portionCalibration: confirmedCalibration,
      }),
    );
  });

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
    // The review box names allergens whenever AI suggested some, because ticking it confirms them.
    expect(html).toContain('I reviewed the AI-drafted text, ingredients and allergens.');
    const reviewed = captured.props!;
    reviewed.setEd({ ...reviewed.ed, draft: { ...reviewed.ed.draft, aiReviewed: true } });
    const accepted = onChange.mock.lastCall![0];
    expect(accepted.ingredients.status).toBe('confirmed');
    expect(accepted.allergens).toEqual({ status: 'confirmed', items: ['milk'] });
    const after = render({ value: accepted, reviewConfirmed: true });
    expect(captured.props!.ed.draft.aiIng).toEqual([]);
    expect(captured.props!.ed.draft.aiAlg).toEqual([]);
    expect(after).toContain('Contains: milk');
  });

  it('keeps unreviewed AI allergens unconfirmed and the original review wording without them', () => {
    const value = emptyManualDish();
    const plain = render({ value, onReviewConfirmedChange: noop });
    expect(plain).toContain('I reviewed the AI-drafted text and ingredients. They are accurate.');
    expect(plain).not.toContain('ingredients and allergens');
  });

  it('says an empty AI allergen answer is not allergen-free and leaves the dish unchanged', async () => {
    captured.buttons = [];
    const onChange = vi.fn();
    const suggestAllergens = vi.fn(async () => [] as string[]);
    const html = () => render({ value: emptyManualDish(), onChange, suggestAllergens });
    html();
    captured.buttons
      .filter((button) => button.children === 'Suggest with AI')
      .at(-1)!
      .onClick?.({} as never);
    await Promise.resolve();
    await Promise.resolve();
    expect(suggestAllergens).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
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
    // Running S07 upload bar while processing: no invented percentage.
    expect(html).toMatch(
      /class="pp-onboard-progress s09-25d-progress pp-onboard-progress--running"/,
    );
    expect(html).not.toContain('aria-valuenow');
    const unavailable = render({ portionReview: { status: 'failed' } });
    expect(unavailable).toContain('original dish photo remains the View Portion fallback');
    expect(unavailable).toContain('>Failed</span>');
    expect(unavailable).toContain('s09-25d-progress--failed');
    expect(unavailable).toContain('role="alert"');
    expect(render()).not.toContain('role="progressbar"');
  });

  it('uses the authored required serving field for the saved people count', () => {
    const html = render({
      value: { ...emptyManualDish(), servingSize: '1 bowl', servingCount: '2' },
    });
    expect(html).toMatch(/id="f-size"[^>]+value="2"/);
    expect(html).toContain('Serving size (people)');
    expect(html).toMatch(/type="number"[^>]+min="1"[^>]+max="100"[^>]+step="1"/);
    expect(html).not.toContain('dish-serving-count');
    const blank = render().match(/<input[^>]+id="f-size"[^>]*>/)?.[0] ?? '';
    expect(blank).toContain('value=""');
    expect(blank).toContain('required');
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
