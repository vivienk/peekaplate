import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DishEditor, type DishEditorProps } from './DishEditor';
import { dishFromReviewItem, emptyManualDish } from './dishForm';
import { evidenceExcerpts } from './evidence';
import { EXTRACTION_ID, reviewSession } from './fixtures.test-helpers';

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
    expect(html).toMatch(/<button[^>]+disabled=""[^>]*>Draft with AI/);
    expect(html).toContain('AI suggestions are not connected yet');
    expect(html).not.toContain('Seasonal vegetables');
  });
  it('preserves explicitly confirmed allergens and does not mark a missing currency as USD', () => {
    const value = emptyManualDish();
    value.allergens = { status: 'confirmed', items: ['milk', 'wheat'] };
    const html = render({ value });
    expect(html).toContain('Contains: milk, wheat');
    expect(html).toContain('Price (currency not set)');
    expect(html).not.toContain('Price (USD)');
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
