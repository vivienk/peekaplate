import { describe, expect, it } from 'vitest';
import {
  allergenOutcome,
  approvalIssues,
  approveCommand,
  approveSavedReviewCommand,
  dishFromManualDraft,
  dishFromReviewItem,
  emptyManualDish,
  manualSaveCommand,
  reviewCorrection,
} from './dishForm';
import { EXTRACTION_ID, reviewSession } from './fixtures.test-helpers';

const firstItem = () => {
  const item = reviewSession().items[0];
  if (!item) throw new Error('fixture has no candidates');
  return item;
};

describe('dishFromReviewItem', () => {
  it('prefills Screen 9 from OCR and keeps unread values unknown', () => {
    // Garden Soup: two printed prices ("8.50 / 12.50 CAD"), so no single amount, and no ingredients.
    const form = dishFromReviewItem(EXTRACTION_ID, firstItem());
    expect(form).toMatchObject({
      origin: 'extracted',
      name: 'Garden Soup',
      category: 'FOOD',
      priceAmount: '',
      priceCurrency: 'CAD',
      ingredients: { status: 'unknown', items: [] },
      allergens: { status: 'unknown', items: [] },
    });
    expect(form.source?.priceText).toBe('8.50 / 12.50 CAD');
    expect(form.source?.uncertainFields).toEqual(
      expect.arrayContaining(['price_amount', 'ingredients', 'description']),
    );
  });

  it('marks OCR ingredients as proposed, never confirmed, and never adds allergens', () => {
    const item = firstItem();
    const withIngredients = {
      ...item,
      effective: { ...item.effective, ingredients: ['Carrot', 'Leek'] },
    };
    const form = dishFromReviewItem(EXTRACTION_ID, withIngredients);
    expect(form.ingredients).toEqual({ status: 'proposed', items: ['Carrot', 'Leek'] });
    expect(form.allergens).toEqual({ status: 'unknown', items: [] });
  });
});

describe('reviewCorrection', () => {
  it('saves and reloads reviewed serving size, allergens and the private photo reference', () => {
    const item = firstItem();
    const form = {
      ...dishFromReviewItem(EXTRACTION_ID, item),
      servingSize: '1 bowl',
      allergens: { status: 'confirmed' as const, items: ['milk' as const] },
      photoId: '00000000-0000-4000-8000-000000000111',
    };
    const correction = reviewCorrection(item, form);
    expect(correction).toMatchObject({
      serving_size: '1 bowl',
      allergens: { status: 'confirmed', items: ['milk'] },
      photo_id: form.photoId,
    });
    const reloaded = dishFromReviewItem(EXTRACTION_ID, {
      ...item,
      effective: {
        ...item.effective,
        serving_size: correction?.serving_size,
        allergens: correction?.allergens,
        photo_id: correction?.photo_id,
      },
    });
    expect(reloaded.servingSize).toBe('1 bowl');
    expect(reloaded.allergens).toEqual(form.allergens);
    expect(reloaded.photoId).toBe(form.photoId);
  });
  it('sends only the fields the owner changed', () => {
    const item = firstItem();
    const form = dishFromReviewItem(EXTRACTION_ID, item);
    expect(reviewCorrection(item, form)).toBeNull();
    form.priceAmount = '8.50';
    form.description = '  Seasonal vegetables  ';
    form.priceCurrency = 'cad';
    expect(reviewCorrection(item, form)).toEqual({
      price_amount: '8.50',
      description: 'Seasonal vegetables',
    });
  });

  it('clears a field to null and turns unknown ingredients into null, not an empty list', () => {
    const item = firstItem();
    const form = dishFromReviewItem(EXTRACTION_ID, item);
    form.category = '';
    form.ingredients = { status: 'proposed', items: ['Carrot', 'Carrot'] };
    expect(reviewCorrection(item, form)).toEqual({ category: null, ingredients: ['Carrot'] });
    form.ingredients = { status: 'unknown', items: [] };
    expect(reviewCorrection(item, form)).toEqual({ category: null });
  });
});

describe('manual dishes', () => {
  it('saves incomplete fields as null and empties an unknown list', () => {
    const form = emptyManualDish();
    form.name = ' Fictional soup ';
    form.priceAmount = '8.50';
    form.priceCurrency = 'usd';
    form.allergens = { status: 'unknown', items: ['milk'] };
    const command = manualSaveCommand(form, 0, '00000000-0000-4000-8000-000000000001');
    expect(command).toEqual({
      commandId: '00000000-0000-4000-8000-000000000001',
      expectedVersion: 0,
      fields: {
        servingSize: null,
        name: 'Fictional soup',
        category: null,
        description: null,
        priceAmount: '8.50',
        priceCurrency: 'USD',
        ingredients: { status: 'unknown', items: [] },
        allergens: { status: 'unknown', items: [] },
        photoId: null,
      },
    });
  });

  it('never saves an extracted dish as a manual draft', () => {
    expect(() =>
      manualSaveCommand(dishFromReviewItem(EXTRACTION_ID, firstItem()), 0, crypto.randomUUID()),
    ).toThrow();
  });

  it('resumes a saved draft from its stored field snapshot', () => {
    const form = dishFromManualDraft({
      id: 'd1',
      job_id: null,
      draft_id: 'd1',
      name: 'Fictional soup',
      description: null,
      category: 'Soup',
      price_amount: '8.50',
      price_currency: 'USD',
      ingredients: ['Carrot'],
      source_text: null,
      review_warnings: [],
      review_status: 'pending',
      origin: 'manual',
      draft_version: 2,
      manual_fields: {
        name: 'Fictional soup',
        category: 'Soup',
        description: null,
        priceAmount: '8.50',
        priceCurrency: 'USD',
        ingredients: { status: 'confirmed', items: ['Carrot'] },
        allergens: { status: 'confirmed', items: ['milk'] },
        photoId: null,
      },
    });
    expect(form).toMatchObject({
      name: 'Fictional soup',
      ingredients: { status: 'confirmed', items: ['Carrot'] },
      allergens: { status: 'confirmed', items: ['milk'] },
    });
  });
});

describe('approval', () => {
  it('blocks an unsaved edit rather than approving the stored price', () => {
    const item = firstItem();
    const form = dishFromReviewItem(EXTRACTION_ID, item);
    expect(approveSavedReviewCommand(item, form, 2, crypto.randomUUID())).toMatchObject({
      expectedDraftVersion: 2,
    });
    form.priceAmount = '9.50';
    expect(() => approveSavedReviewCommand(item, form, 2, crypto.randomUUID())).toThrow(
      'Save your changes',
    );
  });
  it('requires name, category, price and currency, and blocks rejected dishes', () => {
    const form = dishFromReviewItem(EXTRACTION_ID, firstItem());
    expect(approvalIssues(form)).toEqual(['price']);
    form.priceAmount = '8.5';
    expect(approvalIssues(form)).toEqual([]);
    expect(approvalIssues(emptyManualDish())).toEqual(['name', 'category', 'price', 'currency']);
    if (form.source) form.source.rejected = true;
    expect(approvalIssues(form)).toContain('rejected');
  });

  it('never presents unknown allergens as allergen-free', () => {
    const form = emptyManualDish();
    expect(allergenOutcome(form)).toEqual({ label: 'Allergens not confirmed', staffWarning: true });
    form.allergens = { status: 'proposed', items: [] };
    expect(allergenOutcome(form).label).toBe('Allergens not confirmed');
    form.allergens = { status: 'confirmed', items: ['milk', 'egg'] };
    expect(allergenOutcome(form)).toEqual({ label: 'Contains: milk, egg', staffWarning: true });
  });

  it('binds an extracted dish approval to its review session version', () => {
    const extracted = dishFromReviewItem(EXTRACTION_ID, firstItem());
    expect(approveCommand(extracted, 3, '00000000-0000-4000-8000-000000000002')).toEqual({
      commandId: '00000000-0000-4000-8000-000000000002',
      expectedVersion: 0,
      expectedDraftVersion: 3,
      confirmed: true,
      extractionId: EXTRACTION_ID,
      expectedReviewVersion: 0,
    });
    expect(approveCommand(emptyManualDish(), 1, '00000000-0000-4000-8000-000000000003')).toEqual({
      commandId: '00000000-0000-4000-8000-000000000003',
      expectedVersion: 0,
      expectedDraftVersion: 1,
      confirmed: true,
    });
  });
});
