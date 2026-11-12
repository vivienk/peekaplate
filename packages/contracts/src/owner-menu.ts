import { z } from 'zod';

const text = z.string().refine((value) => !value.includes('\u0000'), 'NUL is not supported');
export const PublicMenuAllergenCodeSchema = z.enum([
  'milk',
  'egg',
  'fish',
  'crustacean shellfish',
  'nuts',
  'peanut',
  'wheat',
  'soy',
  'sesame',
]);
const items = <T extends z.ZodType>(item: T) =>
  z
    .strictObject({
      status: z.enum(['unknown', 'proposed', 'confirmed']),
      items: z
        .array(item)
        .max(80)
        .refine((values) => new Set(values).size === values.length),
    })
    .refine((value) => value.status !== 'unknown' || value.items.length === 0);

export const OwnerDishFieldsSchema = z.strictObject({
  name: text.trim().min(1).max(160).nullable().default(null),
  category: text.trim().min(1).max(160).nullable().default(null),
  description: text.trim().max(4000).nullable().default(null),
  priceAmount: z
    .string()
    .regex(/^(0|[1-9]\d{0,7})(\.\d{1,2})?$/)
    .nullable()
    .default(null),
  priceCurrency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable()
    .default(null),
  ingredients: items(text.trim().min(1).max(160)).default({ status: 'unknown', items: [] }),
  allergens: items(PublicMenuAllergenCodeSchema).default({ status: 'unknown', items: [] }),
  photoId: z.uuid().nullable().default(null),
});
export type OwnerDishFields = z.infer<typeof OwnerDishFieldsSchema>;
export const SaveOwnerDishDraftSchema = z.strictObject({
  commandId: z.uuid(),
  expectedVersion: z.number().int().min(0).max(2_147_483_646),
  fields: OwnerDishFieldsSchema,
});
export type SaveOwnerDishDraft = z.infer<typeof SaveOwnerDishDraftSchema>;

// A reviewed revision can preserve unknowns; unknown/proposed values never become public facts.
export const ApprovedDishFactsSchema = z.strictObject({
  category: text.trim().min(1).max(160).nullable(),
  priceAmount: z
    .string()
    .regex(/^(0|[1-9]\d{0,7})(\.\d{1,2})?$/)
    .nullable(),
  priceCurrency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable(),
  ingredients: z.array(text.trim().min(1).max(160)).max(100).nullable(),
  allergens: z.array(PublicMenuAllergenCodeSchema).max(9).nullable(),
  photoId: z.uuid().nullable(),
});
export type ApprovedDishFacts = z.infer<typeof ApprovedDishFactsSchema>;

export const MenuUploadGroupScopeSchema = z.strictObject({ venueId: z.uuid(), groupId: z.uuid() });
export const DraftPhotoScopeSchema = z.strictObject({
  venueId: z.uuid(),
  draftId: z.uuid(),
  photoId: z.uuid(),
});
export const CreateMenuUploadGroupSchema = z
  .strictObject({
    idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
    files: z
      .array(
        z.strictObject({
          sourceType: z.enum(['pdf', 'photo']),
          sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
        }),
      )
      .min(1)
      .max(5),
  })
  .refine(
    (value) => !value.files.some((file) => file.sourceType === 'pdf') || value.files.length === 1,
  );
export const MenuJobActionSchema = z.strictObject({ commandId: z.uuid() });
export const MenuUrlIntakeSchema = z.strictObject({
  url: z.url().max(2048),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
});
