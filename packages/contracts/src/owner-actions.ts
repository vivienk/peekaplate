import { z } from 'zod';

export const OwnerActionRecordSchema = z.object({
  insight_key: z.string().min(1, "Insight key is required"),
  menu_revision: z.string().uuid("Invalid menu revision UUID"),
  category: z.enum(['price_adjustment', 'item_rearrangement', 'description_update', 'promotion']),
  status: z.enum(['planned', 'active', 'archived']),
  note: z.string().max(500, "Note must be under 500 characters").nullable().optional(),
  created_at: z.string().datetime()
});

export type OwnerActionRecord = z.infer<typeof OwnerActionRecordSchema>;
export const CreateOwnerActionSchema = OwnerActionRecordSchema.omit({ created_at: true });
