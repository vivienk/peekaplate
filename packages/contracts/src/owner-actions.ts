import { z } from 'zod';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const postgresText = z
  .string()
  .refine((value) => !value.includes('\u0000'), 'NUL is not supported');

const insightKey = postgresText
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'Expected a stable insight key');
const actionCategory = z.enum([
  'price_adjustment',
  'item_rearrangement',
  'description_update',
  'promotion',
]);

export const OwnerInsightActionStatusSchema = z.enum(['planned', 'active', 'archived']);
export type OwnerInsightActionStatus = z.infer<typeof OwnerInsightActionStatusSchema>;

export const OwnerInsightActionScopeSchema = z.strictObject({
  venueId: uuid,
});
export type OwnerInsightActionScope = z.infer<typeof OwnerInsightActionScopeSchema>;

export const CreateOwnerInsightActionRequestSchema = z.strictObject({
  commandId: uuid,
  insightKey,
  menuId: uuid,
  menuRevisionId: uuid,
  category: actionCategory,
  note: postgresText.trim().min(1).max(500).nullable().optional(),
});
export type CreateOwnerInsightActionRequest = z.infer<typeof CreateOwnerInsightActionRequestSchema>;

export const UpdateOwnerInsightActionRequestSchema = z
  .strictObject({
    commandId: uuid,
    expectedVersion: z.number().int().positive().max(2_147_483_646),
    status: OwnerInsightActionStatusSchema.optional(),
    note: postgresText.trim().min(1).max(500).nullable().optional(),
  })
  .superRefine((request, ctx) => {
    if (request.status === undefined && request.note === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [],
        message: 'At least one of status or note must be supplied',
      });
    }
  });
export type UpdateOwnerInsightActionRequest = z.infer<typeof UpdateOwnerInsightActionRequestSchema>;

export const OwnerInsightActionListQuerySchema = z.strictObject({
  insightKey: insightKey.optional(),
  menuRevisionId: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type OwnerInsightActionListQuery = z.infer<typeof OwnerInsightActionListQuerySchema>;

export const OwnerInsightActionSchema = z.strictObject({
  actionId: uuid,
  venueId: uuid,
  insightKey,
  menuId: uuid,
  menuRevisionId: uuid,
  category: actionCategory,
  status: OwnerInsightActionStatusSchema,
  note: postgresText.max(500).nullable(),
  version: z.number().int().positive().max(2_147_483_647),
  createdBy: uuid,
  updatedBy: uuid,
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type OwnerInsightAction = z.infer<typeof OwnerInsightActionSchema>;

export const OwnerInsightActionResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  action: OwnerInsightActionSchema,
});
export type OwnerInsightActionResponse = z.infer<typeof OwnerInsightActionResponseSchema>;

export const OwnerInsightActionListResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  actions: z.array(OwnerInsightActionSchema),
});
export type OwnerInsightActionListResponse = z.infer<typeof OwnerInsightActionListResponseSchema>;

export const OwnerInsightActionIdSchema = uuid;
