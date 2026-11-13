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
  ingredients: { status: 'confirmed', items: ['a', 'b', 'c', 'd', 'e', 'f'] },
  allergens: { status: 'confirmed', items: ['egg'] },
  ...over,
});

const noPrice = dish({
  id: 'd2',
  name: 'Berry Pancake Stack',
  priceAmount: null,
  ingredients: { status: 'confirmed', items: ['a', 'b', 'c', 'd', 'e'] },
  allergens: { status: 'unknown', items: [] },
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
      onBack={noop}
      onSaveAndExit={noop}
      onPublish={noop}
      {...props}
    />,
  );

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

const publishButton = (html: string) =>
  html.match(/<button[^>]*>Publish Menu<\/button>/)?.[0] ?? '';

describe('ReviewDishes (S10 Menu Review and Publish)', () => {
  it('shows each dish with the status and text from the design', () => {
    const words = text(render(initialReview([dish(), noPrice, noCategory])));
    expect(words).toContain('Your dishes');
    expect(words).toContain('3 dishes');
    expect(words).toContain('Ember & Stone');
    expect(words).toContain('6 ingredients');
    expect(words).toContain('5 ingredients · no allergen recorded');
    expect(words).toContain('$14.00');
    expect(words).toContain('Not found');
    expect(words).toContain('Price Missing');
    expect(words).toContain('Category Missing');
    expect(words).toContain('Ready');
  });

  it('keeps Publish Menu off until every dish is Ready, and explains why', () => {
    const html = render(initialReview([dish(), noPrice]));
    expect(publishButton(html)).toContain('disabled=""');
    expect(text(html)).toContain('Publish Menu opens when every dish is Ready.');
  });

  it('turns Publish Menu on when all dishes are Ready', () => {
    const html = render(initialReview([dish(), dish({ id: 'd9', name: 'Eggs' })]));
    expect(publishButton(html)).not.toContain('disabled');
    expect(text(html)).not.toContain('opens when every dish is Ready');
  });

  it('cannot publish an empty menu and says so', () => {
    const html = render(initialReview([]));
    expect(publishButton(html)).toContain('disabled=""');
    expect(text(html)).toContain('No dishes yet.');
  });

  it('disables Publish Menu and marks it busy while publishing, and shows a failure', () => {
    const state = initialReview([dish()]);
    const busy = render(state, { publishing: true });
    expect(publishButton(busy)).toContain('disabled=""');
    expect(publishButton(busy)).toContain('aria-busy="true"');
    const failed = render(state, { publishError: 'We could not publish. Try again.' });
    expect(failed).toContain('role="alert"');
    expect(text(failed)).toContain('We could not publish. Try again.');
    expect(publishButton(failed)).not.toContain('disabled');
  });

  it('offers Undo after a removal, with the notice announced politely', () => {
    const removed = removeDish(initialReview([dish(), noPrice]), 'd2');
    const html = render(removed);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(text(html)).toContain('Dish removed.');
    expect(html).toContain('>Undo</button>');
    expect(text(html)).not.toContain('Berry Pancake Stack');
    // The only bad dish is gone, so Publish Menu is on.
    expect(publishButton(html)).not.toContain('disabled');
  });

  it('shows Dish restored with no further Undo', () => {
    const restored = undoRemove(removeDish(initialReview([dish(), noPrice]), 'd2'));
    const html = render(restored);
    expect(text(html)).toContain('Dish restored.');
    expect(html).not.toContain('>Undo</button>');
    expect(text(html)).toContain('Berry Pancake Stack');
    expect(publishButton(html)).toContain('disabled=""');
  });

  it('gives every row Edit and Remove buttons a name that includes the dish', () => {
    const html = render(initialReview([dish(), noCategory]));
    expect(html).toContain('aria-label="Edit Avocado Toast"');
    expect(html).toContain('aria-label="Remove Avocado Toast"');
    expect(html).toContain('aria-label="Remove Brioche French Toast"');
  });

  it('uses a real table with column headers and a row header for the dish', () => {
    const html = render(initialReview([dish()]));
    expect(html).toContain('<table');
    expect(html).toContain('scope="col"');
    expect(html).toContain('scope="row"');
    expect(html).toContain('<caption');
  });

  it('shows Back and Save and Exit', () => {
    const words = text(render(initialReview([dish()])));
    expect(words).toContain('Back');
    expect(words).toContain('Save and Exit');
    expect(words).toContain('+ Add dish');
  });
});
