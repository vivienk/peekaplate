import { z } from 'zod';

const text = z
  .string()
  .trim()
  .max(500)
  .refine((value) => !value.includes('\u0000'));
export const RestaurantDetailsSchema = z.strictObject({
  name: text.pipe(z.string().min(1).max(160)),
  city: text.pipe(z.string().min(1)),
  street: text.pipe(z.string().min(1)),
  line2: text,
  phone: text.pipe(z.string().min(1).max(80)),
  email: text.pipe(z.string().max(254)),
});
export const RestaurantLogoSchema = z.strictObject({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  width: z.number().int().min(1).max(2048),
  height: z.number().int().min(1).max(2048),
  sizeBytes: z.number().int().min(45).max(1_000_000),
});
export const RestaurantProfileSchema = z.strictObject({
  version: z.number().int().positive(),
  details: RestaurantDetailsSchema,
  logo: RestaurantLogoSchema.nullable(),
});
export const SaveRestaurantProfileSchema = z.strictObject({
  commandId: z.uuid(),
  expectedVersion: z.number().int().min(0).max(2147483646),
  details: RestaurantDetailsSchema,
  // Omitted preserves the saved logo. Null removes it. Bytes never enter the event stream.
  logoPngBase64: z.string().min(1).max(1_333_336).nullable().optional(),
});
export type RestaurantProfile = z.infer<typeof RestaurantProfileSchema>;
export type SaveRestaurantProfile = z.infer<typeof SaveRestaurantProfileSchema>;
