// S7-VIS-05: extracted price fields must survive the owner's review table, an edit to another dish
// and a reload. The ticket's example: "Lemon Rice Bowl — USD 12.00" and "Sesame Rice Bowl — Small USD
// 9.00 / Large USD 14.00". The backend keeps the printed options as price_text (price_amount stays
// null by design: printed options are not a missing price); the console must not drop them.
import type { ReviewCandidateItemResponse } from '@peekaplate/contracts';
import { describe, expect, it } from 'vitest';
import type { DishDraft } from '../../owner-menu/api';
import { dishFromReviewItem, reviewCorrection } from '../../owner-menu/dishForm';
import { JOB, reviewSession } from '../../owner-menu/fixtures.test-helpers';
import { draftToReviewDish } from './fromDishDraft';
import { priceLabel } from './reviewDishes';

const session = reviewSession();
const extractionId = session.extractionResult.extraction_id;
const template = session.items[0]!;

function item(
  candidateId: string,
  effective: Partial<ReviewCandidateItemResponse['effective']>,
): ReviewCandidateItemResponse {
  const copy = structuredClone(template);
  copy.candidate.candidate_id = candidateId;
  copy.review.candidateId = candidateId;
  copy.effective = { ...copy.effective, ...effective };
  return copy;
}

function draft(id: string, candidateId: string, fields: Partial<DishDraft>): DishDraft {
  return {
    id,
    draft_id: id,
    job_id: JOB,
    candidate_id: candidateId,
    origin: 'extracted',
    draft_version: 1,
    name: 'unused',
    category: null,
    description: null,
    price_amount: null,
    price_currency: null,
    ingredients: null,
    source_text: null,
    review_warnings: [],
    review_status: 'pending',
    ...fields,
  };
}

const LEMON_ID = 'cand-lemon';
const SESAME_ID = 'cand-sesame';
const OPTIONS = 'Small USD 9.00 / Large USD 14.00';

const lemon = item(LEMON_ID, {
  name: 'Lemon Rice Bowl',
  category: 'Rice Bowls',
  price_amount: '12.00',
  price_currency: 'USD',
  price_text: null,
});
const sesame = item(SESAME_ID, {
  name: 'Sesame Rice Bowl',
  category: 'Rice Bowls',
  price_amount: null,
  price_currency: 'USD',
  price_text: OPTIONS,
});
const lemonDraft = draft('11111111-1111-4111-8111-000000000001', LEMON_ID, {
  name: 'Lemon Rice Bowl',
  price_amount: '12.00',
  price_currency: 'USD',
});
const sesameDraft = draft('11111111-1111-4111-8111-000000000002', SESAME_ID, {
  name: 'Sesame Rice Bowl',
  price_text: OPTIONS,
  price_currency: 'USD',
});

const rows = (l: ReviewCandidateItemResponse, s: ReviewCandidateItemResponse) => [
  draftToReviewDish(lemonDraft, extractionId, l),
  draftToReviewDish(sesameDraft, extractionId, s),
];

describe('S7-VIS-05 extracted prices through review, edit and reload', () => {
  it('shows the single price and the printed price options in the review table', () => {
    const [lemonRow, sesameRow] = rows(lemon, sesame);
    expect(priceLabel(lemonRow!)).toBe('$12.00');
    // Printed options are shown as printed, never as "Not found".
    expect(sesameRow!.priceText).toBe(OPTIONS);
    expect(priceLabel(sesameRow!)).toBe(OPTIONS);
  });

  it('keeps the printed options for an extracted draft without a matching review item', () => {
    const row = draftToReviewDish(sesameDraft);
    expect(row.priceText).toBe(OPTIONS);
    expect(priceLabel(row)).toBe(OPTIONS);
  });

  it('changing only Lemon to 12.50 sends one field and leaves Sesame untouched after reload', () => {
    const form = { ...dishFromReviewItem(extractionId, lemon), priceAmount: '12.50' };
    expect(reviewCorrection(lemon, form)).toEqual({ price_amount: '12.50' });
    // Opening Sesame and saving it unchanged must not rewrite anything, including its options.
    expect(reviewCorrection(sesame, dishFromReviewItem(extractionId, sesame))).toBeNull();

    // Reload: the server returns the corrected effective fields for Lemon only.
    const reloadedLemon = item(LEMON_ID, { ...lemon.effective, price_amount: '12.50' });
    const [lemonRow, sesameRow] = rows(reloadedLemon, sesame);
    expect(priceLabel(lemonRow!)).toBe('$12.50');
    expect(priceLabel(sesameRow!)).toBe(OPTIONS);
    // No single amount is invented from the options.
    expect(sesameRow!.priceAmount ?? '').toBe('');
  });
});
