import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReviewDishes, type ReviewDishesProps } from './MenuReview';
import {
  initialReview,
  type ReviewDish,
  type ReviewState,
  removeDish,
  undoRemove,
} from './reviewDishes';

const noop = () => {};
const dish = (over: Partial<ReviewDish> = {}): ReviewDish => ({
  id: 'd1',
  name: 'Avocado Toast',
  category: 'Breakfast',
  priceAmount: '14',
  description: 'Toasted sourdough with smashed avocado.',
  ingredients: { status: 'confirmed', items: ['a', 'b', 'c', 'd', 'e', 'f'] },
  allergens: { status: 'confirmed', items: ['egg'] },
  photoId: 'photo-1',
  ...over,
});

const noPrice = dish({
  id: 'd2',
  name: 'Berry Pancake Stack',
  priceAmount: null,
  ingredients: { status: 'confirmed', items: ['a', 'b', 'c', 'd', 'e'] },
  allergens: { status: 'confirmed', items: [] },
});
const noCategory = dish({ id: 'd3', name: 'Brioche French Toast', category: null });

const render = (state: ReviewState, props: Partial<ReviewDishesProps> = {}) =>
  renderToStaticMarkup(
    <ReviewDishes
      restaurantName="Ember & Stone"
      state={state}
      onAddDish={noop}
      onEditDish={noop}
      onRemoveDish={noop}
      onUndoRemove={noop}
      onCancel={noop}
      onSaveAndExit={noop}
      onCompleteVerification={noop}
      onGoToDashboard={noop}
      {...props}
    />,
  );

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

const completeButton = (html: string) =>
  html.match(/<button[^>]*>Complete verification<\/button>/)?.[0] ?? '';

describe('ReviewDishes (S10 Menu Review)', () => {
  it('shows each dish with the status and text from the design', () => {
    const words = text(render(initialReview([dish(), noPrice, noCategory])));
    expect(words).toContain('Your dishes');
    expect(words).toContain('3 dishes');
    expect(words).toContain('Ember & Stone');
    expect(words).toContain('6 ingredients');
    expect(words).toContain('5 ingredients · no allergen recorded');
    expect(words).toContain('$14.00');
    expect(words).toContain('Not found');
    // One missing detail is named (the price of Berry Pancake Stack, the category of Brioche French Toast).
    expect(words).toContain('Price Missing');
    expect(words).toContain('Category Missing');
    expect(words).not.toMatch(/\d+ fields? missing/);
    expect(words).toContain('Ready');
  });

  it('while any dish is not Ready, the footer is Import more dishes and Save and Exit', () => {
    const html = render(initialReview([dish(), noPrice]));
    const words = text(html);
    expect(words).toContain('Import more dishes');
    expect(words).toContain('Save and Exit');
    expect(words).not.toContain('Cancel');
    expect(completeButton(html)).toBe('');
    expect(words).not.toContain('Back');
    expect(words).not.toContain('Publish');
  });

  it('when every dish is Ready, Complete verification takes the place of Import more dishes', () => {
    const html = render(initialReview([dish(), dish({ id: 'd9', name: 'Eggs' })]));
    const words = text(html);
    expect(words).toContain('Save and Exit');
    expect(completeButton(html)).not.toBe('');
    expect(completeButton(html)).not.toContain('disabled');
    expect(words).not.toContain('Import more dishes');
    // Publishing happens later, from the dashboard's Review and publish step.
    expect(words).not.toContain('Publish');
  });

  it('an empty menu cannot be completed and says so', () => {
    const html = render(initialReview([]));
    expect(completeButton(html)).toBe('');
    expect(text(html)).toContain('Save and Exit');
    expect(text(html)).toContain('No dishes yet.');
  });

  it('disables Complete verification and marks it busy while completing, and shows a failure', () => {
    const state = initialReview([dish()]);
    const busy = render(state, { completing: true });
    expect(completeButton(busy)).toContain('disabled=""');
    expect(completeButton(busy)).toContain('aria-busy="true"');
    const failed = render(state, {
      completeError: 'We could not complete verification. Try again.',
    });
    expect(failed).toContain('role="alert"');
    expect(text(failed)).toContain('We could not complete verification. Try again.');
    expect(completeButton(failed)).not.toContain('disabled');
  });

  it('offers Undo after a removal, with the notice announced politely', () => {
    const removed = removeDish(initialReview([dish(), noPrice]), 'd2');
    const html = render(removed);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(text(html)).toContain('Dish removed.');
    expect(html).toContain('>Undo</button>');
    expect(text(html)).not.toContain('Berry Pancake Stack');
    // The only bad dish is gone, so Complete verification takes the place of Import more dishes.
    expect(completeButton(html)).not.toBe('');
  });

  it('shows Dish restored with no further Undo', () => {
    const restored = undoRemove(removeDish(initialReview([dish(), noPrice]), 'd2'));
    const html = render(restored);
    expect(text(html)).toContain('Dish restored.');
    expect(html).not.toContain('>Undo</button>');
    expect(text(html)).toContain('Berry Pancake Stack');
    expect(completeButton(html)).toBe('');
    expect(text(html)).toContain('Import more dishes');
    expect(text(html)).toContain('Save and Exit');
  });

  it('gives Ready rows Edit and rows that need attention Review, both with Remove', () => {
    const html = render(initialReview([dish(), noCategory]));
    expect(html).toContain('aria-label="Edit Avocado Toast"');
    expect(html).toContain('aria-label="Review Brioche French Toast"');
    expect(html).toContain('aria-label="Remove Avocado Toast"');
    expect(html).toContain('aria-label="Remove Brioche French Toast"');
    expect(html).toMatch(/<th[^>]*>Actions<\/th>/);
  });

  it('shows Pending Review with a Review button for an unreviewed dish with nothing missing', () => {
    const html = render(initialReview([dish({ reviewed: false })]));
    expect(text(html)).toContain('Pending Review');
    expect(html).toContain('aria-label="Review Avocado Toast"');
    expect(text(html)).not.toContain('Complete verification');
  });

  it('names a single missing field and counts when more than one is missing', () => {
    const twoMissing = dish({ id: 'd4', name: 'Cold Brew', priceAmount: null, category: null });
    const oneOther = dish({ id: 'd5', name: 'Granola', photoId: null });
    const words = text(render(initialReview([twoMissing, oneOther])));
    expect(words).toContain('2 fields missing');
    expect(words).toContain('Photo Missing');
    expect(words).not.toContain('1 field missing');
    expect(words).not.toMatch(/(Price|Category)( and \w+)? Missing/);
  });

  it('uses a real table with column headers and a row header for the dish', () => {
    const html = render(initialReview([dish()]));
    expect(html).toContain('<table');
    expect(html).toContain('scope="col"');
    expect(html).toContain('scope="row"');
    expect(html).toContain('<caption');
  });

  it('shows + Add dish', () => {
    expect(text(render(initialReview([dish()])))).toContain('+ Add dish');
  });
});
