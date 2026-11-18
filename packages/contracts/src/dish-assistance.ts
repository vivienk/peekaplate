import { z } from 'zod';
import { PublicMenuAllergenCodeSchema } from './owner-menu';

const description = z
  .string()
  .max(4000)
  .refine((value) => !value.includes('\u0000'));
const version = z.number().int().min(0).max(2_147_483_646);
const request = {
  expectedVersion: version,
  requestId: z.uuid(),
};
export const DishAssistanceRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    ...request,
    operation: z.literal('description'),
    facts: z.strictObject({ description }),
  }),
  z.strictObject({ ...request, operation: z.literal('ingredients'), facts: z.strictObject({}) }),
  // AI allergen guesses from the dish as the owner typed it. Proposals only: the owner must
  // review them, and an empty answer never means "no allergens".
  z.strictObject({
    ...request,
    operation: z.literal('allergens'),
    facts: z.strictObject({
      name: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .refine((value) => !value.includes('\u0000')),
      ingredients: z
        .array(
          z
            .string()
            .trim()
            .min(1)
            .max(256)
            .refine((value) => !value.includes('\u0000')),
        )
        .max(100),
    }),
  }),
]);
export type DishAssistanceRequest = z.infer<typeof DishAssistanceRequestSchema>;
const result = {
  schemaVersion: z.literal('dish-assistance.v1'),
  venueId: z.uuid(),
  draftId: z.uuid(),
  requestId: z.uuid(),
  expectedVersion: version,
  status: z.enum(['review', 'abstained']),
  approvalRequired: z.literal(true),
  publishable: z.literal(false),
  provenance: z.literal('unverified'),
};
const descriptionResult = z
  .strictObject({
    ...result,
    operation: z.literal('description'),
    description: description.min(1).max(600).nullable(),
    evidence: z
      .strictObject({
        source: z.enum(['owner_input', 'saved_description']),
        start: z.number().int().min(0).max(3999),
        end: z.number().int().min(1).max(4000),
        offsetUnit: z.literal('utf16_code_unit'),
      })
      .nullable(),
  })
  .superRefine((value, ctx) => {
    if (
      (value.status === 'review') !== (value.description !== null && value.evidence !== null) ||
      (value.status === 'abstained' && (value.description !== null || value.evidence !== null)) ||
      (value.evidence && value.evidence.end - value.evidence.start !== value.description?.length)
    )
      ctx.addIssue({ code: 'custom', message: 'Inconsistent assistance result' });
  });
const ingredientResult = z
  .strictObject({
    ...result,
    operation: z.literal('ingredients'),
    description: z.null(),
    ingredients: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(256)
          .refine((value) => !value.includes('\u0000')),
      )
      .max(100),
    evidence: z
      .strictObject({
        source: z.enum(['saved_manual_draft', 'saved_extraction', 'saved_owner_correction']),
        snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
        sourceSha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .nullable(),
        extractionId: z.string().min(1).max(256).nullable(),
        candidateId: z.string().min(1).max(256).nullable(),
        reviewVersion: version.nullable(),
      })
      .nullable(),
  })
  .superRefine((value, ctx) => {
    if (
      (value.status === 'review') !== (value.ingredients.length > 0 && value.evidence !== null) ||
      (value.status === 'abstained' && (value.ingredients.length > 0 || value.evidence !== null)) ||
      (value.evidence &&
        (value.evidence.source === 'saved_manual_draft'
          ? value.evidence.sourceSha256 !== null ||
            value.evidence.extractionId !== null ||
            value.evidence.candidateId !== null ||
            value.evidence.reviewVersion !== null
          : value.evidence.sourceSha256 === null ||
            value.evidence.extractionId === null ||
            value.evidence.candidateId === null ||
            value.evidence.reviewVersion === null))
    ) {
      ctx.addIssue({ code: 'custom', message: 'Inconsistent ingredient proposal evidence' });
    }
  });
const allergenResult = z
  .strictObject({
    ...result,
    operation: z.literal('allergens'),
    description: z.null(),
    allergens: z.array(PublicMenuAllergenCodeSchema).max(9),
    evidence: z
      .strictObject({
        source: z.literal('model_inference'),
        inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .nullable(),
  })
  .superRefine((value, ctx) => {
    if (
      (value.status === 'review') !== (value.allergens.length > 0 && value.evidence !== null) ||
      (value.status === 'abstained' && (value.allergens.length > 0 || value.evidence !== null)) ||
      new Set(value.allergens).size !== value.allergens.length
    )
      ctx.addIssue({ code: 'custom', message: 'Inconsistent allergen proposal' });
  });
export const DishAssistanceResultSchema = z.discriminatedUnion('operation', [
  descriptionResult,
  ingredientResult,
  allergenResult,
]);
export type DishAssistanceResult = z.infer<typeof DishAssistanceResultSchema>;
