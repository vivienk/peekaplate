import { z } from 'zod';

export const OwnerVenueSchema = z.strictObject({
  venueId: z.uuid().transform((id) => id.toLowerCase()),
  name: z.string().min(1).max(1000),
  permission: z.enum(['owner', 'editor']),
});

// Membership permits navigation; it establishes no setup, verification or publication status.
export const OwnerWorkspaceResponseSchema = z
  .strictObject({
    actorId: z.uuid().transform((id) => id.toLowerCase()),
    venues: z.array(OwnerVenueSchema).max(100),
  })
  .refine(
    (response) =>
      new Set(response.venues.map((venue) => venue.venueId)).size === response.venues.length,
    'Duplicate restaurant',
  );

export type OwnerVenue = z.infer<typeof OwnerVenueSchema>;
export type OwnerWorkspaceResponse = z.infer<typeof OwnerWorkspaceResponseSchema>;
