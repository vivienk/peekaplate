import { describe, expect, it } from 'vitest';
import type { DishDraft } from '../../owner-menu/api';
import { JOB, reviewSession } from '../../owner-menu/fixtures.test-helpers';
import { draftToReviewDish } from './fromDishDraft';

const session = reviewSession();
const original = session.items[0]!;
const draft: DishDraft = {
  id: '11111111-1111-4111-8111-111111111111',
  draft_id: '11111111-1111-4111-8111-111111111111',
  job_id: JOB,
  candidate_id: original.candidate.candidate_id,
  origin: 'extracted',
  draft_version: 1,
  name: 'Old extraction',
  category: null,
  description: null,
  price_amount: null,
  price_currency: null,
  ingredients: null,
  source_text: null,
  review_warnings: [],
  review_status: 'pending',
};

describe('saved candidate corrections in the review table', () => {
  it('uses the same USD default as Screen 9 while retaining a known source currency', () => {
    expect(draftToReviewDish(draft).priceCurrency).toBe('USD');
    expect(draftToReviewDish({ ...draft, price_currency: 'CAD' }).priceCurrency).toBe('CAD');
    expect(draftToReviewDish({ ...draft, origin: 'manual', manual_fields: {} }).priceCurrency).toBe(
      'USD',
    );
    const item = { ...original, effective: { ...original.effective, price_currency: null } };
    expect(
      draftToReviewDish(draft, session.extractionResult.extraction_id, item).priceCurrency,
    ).toBe('USD');
  });
  it('omits an absent manual serving size while preserving explicit unknown and text', () => {
    const manual = { ...draft, origin: 'manual' as const };
    expect(draftToReviewDish({ ...manual, manual_fields: {} })).not.toHaveProperty('servingSize');
    expect(draftToReviewDish({ ...manual, manual_fields: { servingSize: null } })).toHaveProperty(
      'servingSize',
      null,
    );
    expect(
      draftToReviewDish({ ...manual, manual_fields: { servingSize: '1 bowl' } }),
    ).toHaveProperty('servingSize', '1 bowl');
  });

  it('keeps manual count and descriptive serving size as separate saved facts', () => {
    const row = draftToReviewDish({
      ...draft,
      origin: 'manual',
      manual_fields: { servingSize: '1 bowl', servingCount: 2 },
    });
    expect(row.servingSize).toBe('1 bowl');
    expect(row.servingCount).toBe(2);
  });

  it('maps an extracted count as a number and keeps a missing count unknown', () => {
    const corrected = structuredClone(original);
    corrected.effective.serving_count = 2;
    expect(
      draftToReviewDish(draft, session.extractionResult.extraction_id, corrected).servingCount,
    ).toBe(2);
    corrected.effective.serving_count = null;
    expect(
      draftToReviewDish(draft, session.extractionResult.extraction_id, corrected).servingCount,
    ).toBeNull();
  });

  it('reads the same effective fields as the editor after reloading a review session', () => {
    const corrected = structuredClone(original);
    corrected.effective = {
      ...corrected.effective,
      name: 'Corrected soup',
      category: 'Soup',
      price_amount: '0',
      price_currency: 'USD',
      ingredients: ['Lentils'],
    };
    corrected.review.reviewStatus = 'corrected';
    const row = draftToReviewDish(draft, session.extractionResult.extraction_id, corrected);
    expect(row).toMatchObject({
      name: 'Corrected soup',
      category: 'Soup',
      priceAmount: '0',
      priceCurrency: 'USD',
      ingredients: { status: 'proposed', items: ['Lentils'] },
      allergens: { status: 'unknown', items: [] },
      reviewed: true,
    });
  });
  it('does not mark an unmatched candidate or raw edited status reviewed', () => {
    expect(draftToReviewDish({ ...draft, review_status: 'edited' }).reviewed).toBe(false);
    expect(
      draftToReviewDish(
        { ...draft, candidate_id: 'different' },
        session.extractionResult.extraction_id,
        original,
      ).reviewed,
    ).toBe(false);
  });
});
