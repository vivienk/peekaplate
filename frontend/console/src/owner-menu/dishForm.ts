// FE-06.2: the Screen 9 Add/Edit Dish values, from either source, and what each save sends.
//
// - An extracted dish comes from the review session (OCR). Its values are proposals: ingredients
//   are "proposed", never "confirmed", and allergens are always "unknown" because extraction does
//   not produce allergen data. Saving sends only the changed fields as a review correction.
// - A manual dish is the owner's own draft. Saving replaces the full field snapshot (PUT).
//
// Nothing here turns a missing or unknown value into a fact: an empty unknown allergen list is
// never "no allergens", and approval keeps the staff-warning fallback until allergens are confirmed.
import {
  type ApproveDishDraftRequest,
  type CandidateCorrectedFields,
  type OwnerDishFields,
  OwnerDishFieldsSchema,
  type ReviewCandidateItemResponse,
  type SaveOwnerDishDraft,
} from '@peekaplate/contracts';
import type { DishDraft } from './api';

export type ValueStatus = 'unknown' | 'proposed' | 'confirmed';
export type AllergenCode = OwnerDishFields['allergens']['items'][number];

export type DishForm = {
  origin: 'extracted' | 'manual';
  name: string;
  category: string;
  description: string;
  priceAmount: string;
  priceCurrency: string;
  ingredients: { status: ValueStatus; items: string[] };
  allergens: { status: ValueStatus; items: AllergenCode[] };
  photoId: string | null;
  // Extracted dishes only: where the values came from, kept visible next to the form.
  source: {
    extractionId: string;
    candidateId: string;
    reviewVersion: number;
    // The printed price as read ("8.50 / 12.50 CAD"), shown when no single amount was found.
    priceText: string | null;
    // Fields OCR could not read or the owner marked incomplete, highlighted on the form.
    uncertainFields: string[];
    rejected: boolean;
  } | null;
};

export const STAFF_ALLERGY_LINE = 'For allergy questions, please ask the restaurant staff.';

export function emptyManualDish(): DishForm {
  return {
    origin: 'manual',
    name: '',
    category: '',
    description: '',
    priceAmount: '',
    priceCurrency: '',
    ingredients: { status: 'unknown', items: [] },
    allergens: { status: 'unknown', items: [] },
    photoId: null,
    source: null,
  };
}

const text = (value: string | null | undefined) => value ?? '';
const orNull = (value: string) => (value.trim() === '' ? null : value.trim());

// Screen 9 prefilled from one OCR candidate in the review session.
export function dishFromReviewItem(
  extractionId: string,
  item: ReviewCandidateItemResponse,
): DishForm {
  const { effective, review } = item;
  const ingredients = effective.ingredients ?? null;
  const uncertain = new Set<string>(review.incompleteFields);
  if (!effective.category) uncertain.add('category');
  if (!effective.description) uncertain.add('description');
  if (effective.price_amount === null) uncertain.add('price_amount');
  if (effective.price_currency === null) uncertain.add('price_currency');
  if (ingredients === null || ingredients.length === 0) uncertain.add('ingredients');
  return {
    origin: 'extracted',
    name: effective.name,
    category: text(effective.category),
    description: text(effective.description),
    priceAmount: text(effective.price_amount),
    priceCurrency: text(effective.price_currency),
    ingredients:
      ingredients && ingredients.length > 0
        ? { status: 'proposed', items: [...ingredients] }
        : { status: 'unknown', items: [] },
    // Extraction never supplies allergens; the owner has to add and confirm them.
    allergens: { status: 'unknown', items: [] },
    photoId: null,
    source: {
      extractionId,
      candidateId: review.candidateId,
      reviewVersion: review.version,
      priceText: effective.price_text ?? null,
      uncertainFields: [...uncertain],
      rejected: review.reviewStatus === 'rejected',
    },
  };
}

// Screen 9 for a saved manual draft (resume). Uses the stored field snapshot when it is valid.
export function dishFromManualDraft(draft: DishDraft): DishForm {
  const stored = OwnerDishFieldsSchema.safeParse(draft.manual_fields ?? {});
  const fields: OwnerDishFields = stored.success
    ? stored.data
    : OwnerDishFieldsSchema.parse({
        name: draft.name,
        category: draft.category,
        description: draft.description,
      });
  return {
    origin: 'manual',
    name: text(fields.name),
    category: text(fields.category),
    description: text(fields.description),
    priceAmount: text(fields.priceAmount),
    priceCurrency: text(fields.priceCurrency),
    ingredients: { status: fields.ingredients.status, items: [...fields.ingredients.items] },
    allergens: { status: fields.allergens.status, items: [...fields.allergens.items] },
    photoId: fields.photoId,
    source: null,
  };
}

// An "unknown" list is always empty, whatever was typed before the owner switched it to unknown.
function list<T>(value: { status: ValueStatus; items: T[] }) {
  return {
    status: value.status,
    items: value.status === 'unknown' ? [] : [...new Set(value.items)],
  };
}

// PUT /drafts/:draftId body for a manual dish. Fields may be incomplete while saving.
export function manualSaveCommand(
  form: DishForm,
  expectedVersion: number,
  commandId: string,
): SaveOwnerDishDraft {
  if (form.origin !== 'manual') throw new Error('Only manual dishes are saved as drafts');
  return {
    commandId,
    expectedVersion,
    fields: {
      name: orNull(form.name),
      category: orNull(form.category),
      description: orNull(form.description),
      priceAmount: orNull(form.priceAmount),
      priceCurrency: orNull(form.priceCurrency)?.toUpperCase() ?? null,
      ingredients: list(form.ingredients),
      allergens: list(form.allergens),
      photoId: form.photoId,
    },
  };
}

// The review correction for an extracted dish: only fields that differ from the current effective
// values, or null when nothing changed (no request is sent then).
export function reviewCorrection(
  item: ReviewCandidateItemResponse,
  form: DishForm,
): CandidateCorrectedFields | null {
  const effective = item.effective;
  const corrected: CandidateCorrectedFields = {};
  const name = form.name.trim();
  if (name !== '' && name !== effective.name) corrected.name = name;
  const compare = <K extends 'description' | 'category' | 'price_amount' | 'price_currency'>(
    key: K,
    value: string | null,
  ) => {
    if (value !== (effective[key] ?? null)) corrected[key] = value;
  };
  compare('description', orNull(form.description));
  compare('category', orNull(form.category));
  compare('price_amount', orNull(form.priceAmount));
  compare('price_currency', orNull(form.priceCurrency)?.toUpperCase() ?? null);
  const ingredients =
    form.ingredients.status === 'unknown' ? null : [...new Set(form.ingredients.items)];
  const before = effective.ingredients ?? null;
  if (JSON.stringify(ingredients) !== JSON.stringify(before)) corrected.ingredients = ingredients;
  return Object.keys(corrected).length === 0 ? null : corrected;
}

export type ApprovalIssue = 'name' | 'category' | 'price' | 'currency' | 'rejected';

// What blocks owner verification. Name, category, price and currency are required; ingredients and
// allergens may stay unknown (diners then see the staff line instead of a list).
export function approvalIssues(form: DishForm): ApprovalIssue[] {
  const issues: ApprovalIssue[] = [];
  if (form.source?.rejected) issues.push('rejected');
  if (form.name.trim() === '') issues.push('name');
  if (form.category.trim() === '') issues.push('category');
  if (!/^(0|[1-9]\d{0,7})(\.\d{1,2})?$/.test(form.priceAmount.trim())) issues.push('price');
  if (!/^[A-Z]{3}$/.test(form.priceCurrency.trim().toUpperCase())) issues.push('currency');
  return issues;
}

// What diners will be told about allergens if this dish is approved as it stands.
export function allergenOutcome(form: DishForm): { label: string; staffWarning: boolean } {
  if (form.allergens.status !== 'confirmed')
    return { label: 'Allergens not confirmed', staffWarning: true };
  if (form.allergens.items.length === 0)
    return { label: 'Confirmed: no listed allergens', staffWarning: true };
  return { label: `Contains: ${form.allergens.items.join(', ')}`, staffWarning: true };
}

// The approve body. Extracted dishes also bind the review session and its current version.
export function approveCommand(
  form: DishForm,
  draftVersion: number,
  commandId: string,
): ApproveDishDraftRequest {
  return {
    commandId,
    expectedVersion: 0,
    expectedDraftVersion: draftVersion,
    confirmed: true,
    ...(form.source
      ? { extractionId: form.source.extractionId, expectedReviewVersion: form.source.reviewVersion }
      : {}),
  };
}
