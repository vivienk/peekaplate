// S8 "Review menu": turns a saved dish draft from the owner menu API (DishDraft) into the row the
// review table shows (ReviewDish). Manual drafts keep their stored OwnerDishFields, so confirmed
// facts stay confirmed. Extracted drafts only have the proposed text the extraction found: their
// ingredients are proposed (never confirmed), allergens are unknown and there is no photo, so the
// row shows what is still missing until the owner corrects it in the dish form (S09).
import { OwnerDishFieldsSchema, type ReviewCandidateItemResponse } from '@peekaplate/contracts';
import type { DishDraft } from '../../owner-menu/api';
import { dishFromReviewItem } from '../../owner-menu/dishForm';
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
        servingSize: fields.servingSize,
        ...(fields.servingCount !== undefined && { servingCount: fields.servingCount }),
        priceAmount: fields.priceAmount,
        priceCurrency: fields.priceCurrency,
        ingredients: fields.ingredients,
        allergens: fields.allergens,
        photoId: fields.photoId,
        reviewed: true,
      };
    }
  }
  if (extractionId && item && item.candidate.candidate_id === draft.candidate_id) {
    return {
      id: draft.id,
      ...dishFromReviewItem(extractionId, item),
      servingCount: item.effective.serving_count ?? null,
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
    priceCurrency: draft.price_currency,
    ingredients: { status: proposed.length > 0 ? 'proposed' : 'unknown', items: proposed },
    allergens: { status: 'unknown', items: [] },
    photoId: null,
    // An extracted dish is Pending Review until the owner has reviewed it in S09.
    reviewed: false,
  };
}
