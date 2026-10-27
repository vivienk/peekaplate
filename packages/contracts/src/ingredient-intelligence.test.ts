import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CreateDishRevisionSchema } from './index.js';
import {
  IngredientReviewHandoffSchema,
  ingredientAssessmentForReview,
} from './ingredient-intelligence.js';

const fixture = JSON.parse(
  readFileSync('processing/tests/fixtures/ingredient-review.json', 'utf8'),
);
const expected = {
  draftIndex: 0,
  draftId: 'draft:synthetic',
  inputSha256: fixture.assessments[0].input_sha256,
  sourceId: 'source:synthetic',
  sourceSha256: 'a'.repeat(64),
  segments: new Map([['page:1', '  🥣 Dish\nIngredients: milk, house sauce']]),
};

describe('AI-02 → RES-01 review boundary', () => {
  it('consumes the exact Python fixture and preserves unknowns and source spans', () => {
    const result = ingredientAssessmentForReview(fixture, expected);
    expect(result.ingredients[0]?.original).toBe('milk');
    expect(result.ingredients[1]?.reason).toBe('unrecognized_ingredient');
    expect(result.allergens.milk.status).toBe('possible_presence');
    expect(result.dietary.vegan.status).toBe('possible_incompatible');
    expect(result.dietary.vegetarian.status).toBe('unknown');
    expect(result.owner_confirmation_required).toBe(true);
    expect(result.publishable).toBe(false);
  });

  it.each([
    { draftId: 'other' },
    { draftIndex: 1 },
    { inputSha256: 'b'.repeat(64) },
    { sourceId: 'other' },
    { sourceSha256: 'b'.repeat(64) },
    { segments: new Map() },
    { segments: new Map([['page:1', 'different source']]) },
  ])('rejects stale/crossed identities and changed evidence: %j', (change) => {
    expect(() => ingredientAssessmentForReview(fixture, { ...expected, ...change })).toThrow();
  });

  it.each([
    (v: typeof fixture) => {
      v.publishable = true;
    },
    (v: typeof fixture) => {
      v.owner_confirmation_required = false;
    },
    (v: typeof fixture) => {
      v.approved_by = 'owner';
    },
    (v: typeof fixture) => {
      v.assessments[0].publishable = true;
    },
    (v: typeof fixture) => {
      v.assessments[0].allergens.milk.status = 'absent';
    },
    (v: typeof fixture) => {
      v.assessments[0].dietary.vegan.status = 'compatible';
    },
    (v: typeof fixture) => {
      v.assessments[0].allergens.milk.ingredient_indices = [1];
    },
    (v: typeof fixture) => {
      v.assessments[0].ingredients[0].evidence = [];
    },
    (v: typeof fixture) => {
      v.assessments[0].ingredients[0].evidence[0].end += 1;
    },
    (v: typeof fixture) => {
      v.assessments[0].ingredients[0].evidence[0].source_id = 'other';
    },
    (v: typeof fixture) => {
      v.assessments[0].ingredients[0].rule_id = 'invented-rule';
    },
    (v: typeof fixture) => {
      v.assessments[0].draft_index = 99;
    },
  ])('rejects forged approval, unsupported claims and broken provenance', (mutate) => {
    const input = structuredClone(fixture);
    mutate(input);
    expect(IngredientReviewHandoffSchema.safeParse(input).success).toBe(false);
  });

  it('cannot be submitted to the existing draft revision command as published claims', () => {
    expect(
      CreateDishRevisionSchema.safeParse({
        commandId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        expectedVersion: 0,
        name: 'Dish',
        description: 'Description',
        ingredientAssessment: fixture.assessments[0],
      }).success,
    ).toBe(false);
  });
});
