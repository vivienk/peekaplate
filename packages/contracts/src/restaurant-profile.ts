import { z } from 'zod';

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((value) => !value.includes('\u0000'), 'NUL is not supported');

export const RestaurantDetailsSchema = z.strictObject({
  name: text(160).min(1),
  city: text(160).min(1),
  street: text(300).min(1),
  line2: text(300),
  phone: text(40)
    .regex(/^\+?[\d\s().-]+$/)
    .refine(
      (value) => value.replace(/\D/g, '').length >= 7 && value.replace(/\D/g, '').length <= 15,
    ),
  email: text(254).refine((value) => value === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)),
});

export const RestaurantProfileFieldsSchema = RestaurantDetailsSchema.extend({
  photoId: z.uuid().nullable().default(null),
});
export type RestaurantProfileFields = z.infer<typeof RestaurantProfileFieldsSchema>;
export const SaveRestaurantProfileSchema = z.strictObject({
  commandId: z.uuid(),
  expectedVersion: z.number().int().min(0).max(2_147_483_646),
  fields: RestaurantProfileFieldsSchema,
});
export type SaveRestaurantProfile = z.infer<typeof SaveRestaurantProfileSchema>;
export const RestaurantProfileSchema = z.strictObject({
  version: z.number().int().positive(),
  fields: RestaurantProfileFieldsSchema,
  status: z.enum(['submitted', 'verified']),
});
export type RestaurantProfile = z.infer<typeof RestaurantProfileSchema>;
export const RestaurantProfileResponseSchema = z.strictObject({
  profile: RestaurantProfileSchema.nullable(),
});
export const RestaurantSetupSchema = z.strictObject({
  venueId: z.uuid(),
  restaurantName: text(1000).min(1),
  detailsStatus: z.enum(['missing', 'submitted', 'verified']),
  menuAdded: z.boolean(),
  menuVerified: z.boolean(),
  published: z.boolean(),
});
export type RestaurantSetup = z.infer<typeof RestaurantSetupSchema>;
