import { z } from 'zod';

const text = z.string().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const index = z.number().int().min(0).max(999);
const rule = z.string().regex(/^ingredient-rules\.1:[a-z ]{1,64}$/);
const refs = {
  ingredient_indices: z.array(index).max(100),
  rule_ids: z.array(rule).max(100),
};
const allergen = z.strictObject({ status: z.enum(['possible_presence', 'unknown']), ...refs });
const dietary = z.strictObject({ status: z.enum(['possible_incompatible', 'unknown']), ...refs });

/** Suggestions only. This contract deliberately cannot represent owner approval. */
export const IngredientAssessmentSchema = z
  .strictObject({
    schema_version: z.literal('ingredient-intelligence.v1'),
    policy_version: z.literal('ingredient-rules.1'),
    source_id: text.nullable(),
    source_sha256: hash.nullable(),
    draft_id: text.nullable(),
    draft_index: index,
    input_sha256: hash,
    status: z.enum(['needs_review', 'unknown']),
    owner_confirmation_required: z.literal(true),
    publishable: z.literal(false),
    ingredients: z
      .array(
        z.strictObject({
          ingredient_index: index,
          original: text,
          normalized: text,
          canonical: text.nullable(),
          status: z.enum(['needs_review', 'unknown']),
          reason: z.enum([
            'exact_rule',
            'unrecognized_ingredient',
            'missing_evidence',
            'qualified_context',
          ]),
          rule_id: rule.nullable(),
          evidence: z
            .array(
              z
                .strictObject({
                  source_id: text,
                  segment_id: text,
                  start: z.number().int().min(0).max(100_000),
                  end: z.number().int().positive().max(100_000),
                  text,
                  offset_unit: z.literal('unicode_codepoint'),
                  association: z.literal('unverified'),
                })
                .refine((span) => span.end - span.start === Array.from(span.text).length, {
                  message: 'Evidence length must match Unicode code-point span',
                }),
            )
            .max(8),
        }),
      )
      .max(100),
    allergens: z.strictObject({
      milk: allergen,
      egg: allergen,
      fish: allergen,
      crustacean_shellfish: allergen,
      tree_nut: allergen,
      peanut: allergen,
      wheat: allergen,
      soy: allergen,
      sesame: allergen,
    }),
    dietary: z.strictObject({ vegan: dietary, vegetarian: dietary, gluten_free: dietary }),
    warnings: z.array(z.string().min(1).max(512)).min(1).max(10),
    references: z
      .array(
        z.literal(
          'https://www.fda.gov/food/nutrition-food-labeling-and-critical-foods/food-allergies',
        ),
      )
      .length(1),
  })
  .superRefine((assessment, ctx) => {
    const invalid = (message: string) => ctx.addIssue({ code: 'custom', message });
    for (const [position, ingredient] of assessment.ingredients.entries()) {
      if (ingredient.ingredient_index !== position) invalid('Ingredient indices must be ordered');
      const matched = ingredient.reason === 'exact_rule';
      if (
        (ingredient.status === 'needs_review') !== matched ||
        (ingredient.rule_id !== null) !== matched ||
        (matched && (!ingredient.canonical || ingredient.evidence.length === 0))
      )
        invalid('Matched ingredients require evidence and rule provenance');
      if (
        ingredient.evidence.some((span) => span.source_id !== assessment.source_id) ||
        (ingredient.reason === 'missing_evidence') !== (ingredient.evidence.length === 0)
      )
        invalid('Ingredient evidence must match its source and reason');
    }
    if (
      (assessment.status === 'needs_review') !==
      assessment.ingredients.some((ingredient) => ingredient.status === 'needs_review')
    )
      invalid('Assessment status must match ingredient statuses');
    if (
      assessment.status === 'needs_review' &&
      (!assessment.source_id || !assessment.source_sha256 || !assessment.draft_id)
    )
      invalid('Suggestions require a bound source and draft');
    for (const classification of [
      ...Object.values(assessment.allergens),
      ...Object.values(assessment.dietary),
    ]) {
      if (
        classification.ingredient_indices.length !== classification.rule_ids.length ||
        new Set(classification.ingredient_indices).size !==
          classification.ingredient_indices.length ||
        (classification.status === 'unknown') !== (classification.ingredient_indices.length === 0)
      )
        invalid('Classification must cite unique ingredients and matching rules');
      classification.ingredient_indices.forEach((ingredientIndex, position) => {
        const ingredient = assessment.ingredients[ingredientIndex];
        if (
          !ingredient ||
          ingredient.status !== 'needs_review' ||
          ingredient.rule_id !== classification.rule_ids[position]
        )
          invalid('Classification cites an unsupported ingredient or rule');
      });
    }
  });

export const IngredientReviewHandoffSchema = z
  .strictObject({
    schema_version: z.literal('ingredient-review.v1'),
    policy_version: z.literal('ingredient-rules.1'),
    owner_confirmation_required: z.literal(true),
    publishable: z.literal(false),
    assessments: z.array(IngredientAssessmentSchema).max(1000),
  })
  .superRefine((handoff, ctx) => {
    if (handoff.assessments.some((assessment, position) => assessment.draft_index !== position)) {
      ctx.addIssue({ code: 'custom', message: 'Assessments must follow original draft order' });
    }
  });

export type IngredientAssessment = z.infer<typeof IngredientAssessmentSchema>;

/**
 * RES-01 consumer boundary. Expected identity and segments must come from trusted
 * saved extraction, never browser authority fields. No persistence or approval.
 */
export function ingredientAssessmentForReview(
  raw: unknown,
  expected: {
    draftIndex: number;
    draftId: string;
    inputSha256: string;
    sourceId: string;
    sourceSha256: string;
    segments: ReadonlyMap<string, string>;
  },
): IngredientAssessment {
  const handoff = IngredientReviewHandoffSchema.parse(raw);
  const assessment = handoff.assessments[expected.draftIndex];
  if (
    !assessment ||
    assessment.draft_id !== expected.draftId ||
    assessment.input_sha256 !== expected.inputSha256 ||
    assessment.source_id !== expected.sourceId ||
    assessment.source_sha256 !== expected.sourceSha256
  )
    throw new Error('Ingredient assessment is stale or belongs to another draft/source');
  for (const ingredient of assessment.ingredients) {
    for (const span of ingredient.evidence) {
      const segment = expected.segments.get(span.segment_id);
      if (
        segment === undefined ||
        Array.from(segment).slice(span.start, span.end).join('') !== span.text
      )
        throw new Error('Ingredient evidence does not match the saved source');
    }
  }
  return assessment;
}
