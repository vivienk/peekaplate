import type { ExtractionReviewSessionResponse } from '@peekaplate/contracts';
import type { DishDraft } from '../owner-menu/api';
import { draftToReviewDish } from './review/fromDishDraft';

export type MenuSnapshot = {
  venueId: string;
  verified: boolean;
  dishes: { id: string; name: string; category: string; priceLabel: string }[];
};

// Navigation reflects saved verification. It never approves or publishes a draft.
export function menuSnapshot(
  venueId: string,
  drafts: readonly DishDraft[],
  reviews: Record<string, ExtractionReviewSessionResponse>,
  incomplete: boolean,
): MenuSnapshot {
  const active = drafts.filter(
    (draft) => !draft.removed_at && !['rejected', 'superseded'].includes(draft.review_status),
  );
  return {
    venueId,
    verified:
      !incomplete &&
      active.length > 0 &&
      active.every((draft) => draft.verification_status === 'verified'),
    dishes: active.map((draft) => {
      const session = draft.job_id ? reviews[draft.job_id] : undefined;
      const item = session?.items.find(
        (entry) => entry.candidate.candidate_id === draft.candidate_id,
      );
      const dish = draftToReviewDish(draft, session?.extractionResult.extraction_id, item);
      let priceLabel = 'Price not set';
      if (
        dish.priceAmount != null &&
        /^(0|[1-9]\d{0,7})(\.\d{1,2})?$/.test(dish.priceAmount) &&
        /^[A-Z]{3}$/.test(dish.priceCurrency ?? '')
      ) {
        priceLabel = new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: dish.priceCurrency!,
        }).format(Number(dish.priceAmount));
      }
      return {
        id: draft.id,
        name: dish.name ?? 'Unnamed dish',
        category: dish.category ?? '',
        priceLabel,
      };
    }),
  };
}
