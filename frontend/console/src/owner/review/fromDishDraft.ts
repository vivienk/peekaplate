// S8 "Review menu": turns a saved dish draft from the owner menu API (DishDraft) into the row the
// review table shows (ReviewDish). Manual drafts keep their stored OwnerDishFields, so confirmed
// facts stay confirmed. Extracted drafts only have the proposed text the extraction found: their
// ingredients are proposed (never confirmed), allergens are unknown and there is no photo, so the
// row shows what is still missing until the owner corrects it in the dish form (S09).
import { OwnerDishFieldsSchema, type ReviewCandidateItemResponse } from '@peekaplate/contracts';
import type { DishDraft } from '../../owner-menu/api';
import { dishFromReviewItem, pilotPriceCurrency } from '../../owner-menu/dishForm';
import { servingCountValue } from '../../owner-menu/servingCount';
import type { ReviewDish } from './reviewDishes';

// Draft review statuses that mean the owner has already reviewed or corrected the dish.

export function draftToReviewDish(
  draft: DishDraft,
  extractionId?: string,
  item?: ReviewCandidateItemResponse,
): ReviewDish {
  if (draft.origin === 'manual') {
    const parsed = OwnerDishFieldsSchema.safeParse(draft.manual_fields);
    if (parsed.success) {
      const fields = parsed.data;
      return {
        id: draft.id,
        name: fields.name,
        category: fields.category,
        description: fields.description,
        ...(fields.servingSize !== undefined && { servingSize: fields.servingSize }),
        ...(fields.servingCount !== undefined && { servingCount: fields.servingCount }),
        ...(fields.portionCalibration !== undefined && {
          portionCalibration: fields.portionCalibration,
        }),
        priceAmount: fields.priceAmount,
        priceCurrency: pilotPriceCurrency(fields.priceCurrency),
        ingredients: fields.ingredients,
        allergens: fields.allergens,
        photoId: fields.photoId,
        reviewed: true,
      };
    }
  }
  if (extractionId && item && item.candidate.candidate_id === draft.candidate_id) {
    const form = dishFromReviewItem(extractionId, item);
    return {
      id: draft.id,
      ...form,
      priceText: form.source?.priceText ?? null,
      servingCount: servingCountValue(form.servingCount ?? ''),
      reviewed: item.review.reviewStatus === 'corrected',
    };
  }
  const proposed = (draft.ingredients ?? []).filter(
    (item): item is string => typeof item === 'string' && item.trim() !== '',
  );
  return {
    id: draft.id,
    name: draft.name,
    category: draft.category,
    description: draft.description,
    priceAmount: draft.price_amount,
    priceCurrency: pilotPriceCurrency(draft.price_currency),
    priceText: draft.price_text ?? null,
    ingredients: { status: proposed.length > 0 ? 'proposed' : 'unknown', items: proposed },
    allergens: { status: 'unknown', items: [] },
    photoId: null,
    // An extracted dish is Pending Review until the owner has reviewed it in S09.
    reviewed: false,
  };
}
