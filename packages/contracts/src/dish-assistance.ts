import { z } from 'zod';

const description = z
  .string()
  .max(4000)
  .refine((value) => !value.includes('\u0000'));
const operation = z.literal('description');
const version = z.number().int().min(0).max(2_147_483_646);
export const DishAssistanceRequestSchema = z.strictObject({
  operation,
  expectedVersion: version,
  requestId: z.uuid(),
  facts: z.strictObject({ description }),
});
export type DishAssistanceRequest = z.infer<typeof DishAssistanceRequestSchema>;
export const DishAssistanceResultSchema = z
  .strictObject({
    schemaVersion: z.literal('dish-assistance.v1'),
    venueId: z.uuid(),
    draftId: z.uuid(),
    requestId: z.uuid(),
    expectedVersion: version,
    operation,
    status: z.enum(['review', 'abstained']),
    description: description.min(1).max(600).nullable(),
    evidence: z
      .strictObject({
        source: z.enum(['owner_input', 'saved_description']),
        start: z.number().int().min(0).max(3999),
        end: z.number().int().min(1).max(4000),
        offsetUnit: z.literal('utf16_code_unit'),
      })
      .nullable(),
    approvalRequired: z.literal(true),
    publishable: z.literal(false),
    provenance: z.literal('unverified'),
  })
  .superRefine((value, ctx) => {
    if (
      (value.status === 'review') !== (value.description !== null && value.evidence !== null) ||
      (value.status === 'abstained' && (value.description !== null || value.evidence !== null)) ||
      (value.evidence && value.evidence.end - value.evidence.start !== value.description?.length)
    )
      ctx.addIssue({ code: 'custom', message: 'Inconsistent assistance result' });
  });
export type DishAssistanceResult = z.infer<typeof DishAssistanceResultSchema>;
