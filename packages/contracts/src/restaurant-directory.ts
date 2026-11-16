import { z } from 'zod';

export const PublicRestaurantDirectorySchema = z.strictObject({
  schemaVersion: z.literal(1),
  restaurants: z.array(z.strictObject({ venueId: z.uuid(), menuId: z.uuid() })).max(64),
  nextCursor: z.uuid().nullable(),
});
