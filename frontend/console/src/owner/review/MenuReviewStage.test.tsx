import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReviewDishes, type ReviewDishesProps } from './MenuReview';
import { initialReview, type ReviewDish } from './reviewDishes';

const noop = () => {};
const dish = (over: Partial<ReviewDish> = {}): ReviewDish => ({
  id: 'd1',
  name: 'Avocado Toast',
  category: 'Breakfast',
  description: 'Toasted bread with smashed avocado and a poached egg.',
  priceAmount: '14',
  ingredients: { status: 'confirmed', items: ['Bread', 'Avocado', 'Egg'] },
  allergens: { status: 'confirmed', items: ['egg'] },
  photoId: 'photo-1',
  ...over,
});

const render = (dishes: ReviewDish[], props: Partial<ReviewDishesProps> = {}) =>
  renderToStaticMarkup(
    <ReviewDishes
      restaurantName="Ember & Stone"
      state={initialReview(dishes)}
      onAddDish={noop}
      onEditDish={noop}
      onCancel={noop}
      onSaveAndExit={noop}
      onCompleteVerification={noop}
      onGoToDashboard={noop}
      {...props}
    />,
  );

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('S8 Review menu (Pending Review, then Ready)', () => {
  it('shows Pending Review and Review for unreviewed dishes, and the missing-detail label for the rest', () => {
    const html = render([
      dish({ reviewed: false }),
      dish({ id: 'd2', name: 'Berry Pancake Stack', priceAmount: null, reviewed: false }),
    ]);
    const words = text(html);
    expect(words).toContain('Pending Review');
    expect(html).toContain('review-status--warning">Pending Review');
    expect(words).toContain('Price Missing');
    expect(words).toContain('Import more dishes');
    expect(words).toContain('Save and Exit');
    expect(words).not.toContain('Complete verification');
    expect(html).toContain('aria-label="Review Avocado Toast"');
    expect(html).toContain('aria-label="Review Berry Pancake Stack"');
  });

  it('has an Actions column and no Remove button when removal is not wired', () => {
    const html = render([dish({ reviewed: false })]);
    expect(html).toMatch(/<th[^>]*>Actions<\/th>/);
    expect(html).not.toContain('aria-label="Remove');
  });

  it('shows Ready with an Edit button once the dishes are reviewed, and swaps the footer', () => {
    const html = render([
      dish({ reviewed: true }),
      dish({ id: 'd2', name: 'Eggs Benedict', reviewed: true }),
    ]);
    const words = text(html);
    expect(words).toContain('Ready');
    expect(html).toContain('review-status--success">Ready');
    expect(words).not.toContain('Pending Review');
    expect(words).toContain('Complete verification');
    expect(words).toContain('Save and Exit');
    expect(words).not.toContain('Import more dishes');
    expect(html).toContain('aria-label="Edit Avocado Toast"');
  });

  it('keeps Complete verification hidden while any dish is still Pending Review', () => {
    const words = text(render([dish({ reviewed: true }), dish({ id: 'd2', reviewed: false })]));
    expect(words).not.toContain('Complete verification');
    expect(words).toContain('Import more dishes');
  });

  it('shows Remove on every row when removal is wired', () => {
    const html = render([dish()], { onRemoveDish: noop, onUndoRemove: noop });
    expect(html).toContain('aria-label="Remove Avocado Toast"');
    expect(html).toContain('aria-label="Edit Avocado Toast"');
  });
});
