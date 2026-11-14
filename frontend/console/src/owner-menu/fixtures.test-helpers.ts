// Test-only helpers: a review session built from the shared synthetic extraction fixture
// (processing/tests/fixtures/review-candidates), shaped like the API's response. Synthetic data.
import type {
  ExtractionReviewSessionResponse,
  ReviewCandidateItemResponse,
} from '@peekaplate/contracts';
import extraction from '../../../../processing/tests/fixtures/review-candidates/representative-candidates-v2.json';

export const VENUE = '0f0e0d0c-0b0a-4908-8706-050403020100';
export const JOB = '11111111-2222-4333-8444-555555555555';

type Original = ExtractionReviewSessionResponse['items'][number]['candidate']['original'];

function item(candidate: ExtractionReviewSessionResponse['items'][number]['candidate']) {
  const original = candidate.original as Original;
  const response: ReviewCandidateItemResponse = {
    candidate,
    review: {
      extractionId: extraction.extraction_id,
      candidateId: candidate.candidate_id,
      revisionId: null,
      version: 0,
      reviewStatus: 'pending',
      corrected: {},
      editedFields: [],
      incompleteFields: [],
      reviewNote: null,
      reviewedBy: null,
      reviewedAt: null,
      publishable: false,
    },
    effective: {
      name: original.name,
      description: original.description,
      category: original.category,
      subcategory: original.subcategory ?? null,
      category_page_number: original.category_page_number ?? null,
      price_text: original.price_text ?? null,
      price_amount: original.price_amount,
      price_currency: original.price_currency,
      ingredients: original.ingredients,
    },
  };
  return response;
}

export function reviewSession(): ExtractionReviewSessionResponse {
  const result = extraction as unknown as ExtractionReviewSessionResponse['extractionResult'];
  return {
    schemaVersion: 1,
    venueId: VENUE,
    extractionResult: result,
    items: result.candidates.map(item),
    privateArtifactRef: null,
    published: false,
  };
}

export const EXTRACTION_ID = extraction.extraction_id;
