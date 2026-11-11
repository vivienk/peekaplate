import { z } from 'zod';

// Public, reviewed T1 layers only. Processing manifests (needs_review) are not this contract.
// Inclusion in the approved immutable menu is the publication boundary, not a browser flag.
export const PublicPortionSchema = z
  .strictObject({
    schema_version: z.literal(1),
    dish_id: z.uuid(),
    dish_revision_id: z.uuid(),
    width: z.number().int().positive().max(2048),
    height: z.number().int().positive().max(2048),
    motion: z
      .strictObject({
        max_yaw_degrees: z.number().min(0).max(3),
        max_pitch_degrees: z.number().min(0).max(3),
      })
      .optional(),
    layers: z
      .array(
        z.strictObject({
          url: z
            .url()
            .max(2048)
            .refine((value) => {
              try {
                const url = new URL(value);
                return url.protocol === 'https:' && !url.username && !url.password;
              } catch {
                return false;
              }
            }),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          size_bytes: z.number().int().positive().max(180_000),
          depth: z.number().min(0).max(1),
        }),
      )
      .min(2)
      .max(6),
  })
  .superRefine((value, ctx) => {
    if (
      new TextEncoder().encode(JSON.stringify(value)).byteLength > 20_000 ||
      value.layers.filter((layer) => layer.depth === 0).length !== 1 ||
      !value.layers.some((layer) => layer.depth > 0) ||
      value.layers.reduce((sum, layer) => sum + layer.size_bytes, 0) > 180_000
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'T1 requires one background, foreground and bounded assets',
      });
    }
  });

export type PublicPortion = z.infer<typeof PublicPortionSchema>;
