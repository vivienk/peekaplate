import { z } from 'zod';

export const artworkLabel = (value: string) =>
  value.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ');
export const ArtworkLabelSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[\p{L} '-]+$/u)
  .refine((value) => artworkLabel(value) === value);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const common = {
  commandId: z.uuid(),
  expectedVersion: z.number().int().min(0).max(2147483646),
  label: ArtworkLabelSchema,
  reason: z.string().trim().min(1).max(1000),
};
export const ArtworkCommandSchema = z.discriminatedUnion('status', [
  z
    .object({
      ...common,
      status: z.literal('approved'),
      sha256: hash,
      pngBase64: z.string().min(1).max(1_333_336),
      sourceAssetId: hash,
      styleVersion: z.literal('figma-149-2169.v1'),
      rightsConfirmed: z.literal(true),
      recipe: z.string().min(1).max(4000),
    })
    .strict(),
  z.object({ ...common, status: z.literal('revoked') }).strict(),
]);
export type ArtworkCommand = z.infer<typeof ArtworkCommandSchema>;
export const ArtworkStateSchema = z
  .object({
    label: ArtworkLabelSchema,
    version: z.number().int().positive(),
    status: z.enum(['approved', 'revoked']),
    sha256: hash.nullable(),
  })
  .strict();
export type ArtworkState = z.infer<typeof ArtworkStateSchema>;
export const PublicArtworkSchema = z
  .object({
    schemaVersion: z.literal(1),
    icons: z
      .array(ArtworkStateSchema.refine((v) => v.status === 'approved' && v.sha256 !== null))
      .max(100),
  })
  .strict();
