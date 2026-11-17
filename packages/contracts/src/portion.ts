import { z } from 'zod';

// Number of people served; never a physical scale multiplier.
export const ServingCountSchema = z.number().int().min(1).max(100);

export const PlateCalibrationSchema = z
  .strictObject({
    shape: z.enum(['round', 'rectangular']),
    width_mm: z.number().int().min(30).max(1000),
    depth_mm: z.number().int().min(30).max(1000),
    source_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    source_width_px: z.number().int().positive().max(24_000_000),
    source_height_px: z.number().int().positive().max(24_000_000),
    boundary: z.strictObject({
      x: z.number().min(0).max(0.95),
      y: z.number().min(0).max(0.95),
      width: z.number().min(0.05).max(1),
      height: z.number().min(0.05).max(1),
    }),
    confirmed: z.literal(true),
  })
  .superRefine((value, ctx) => {
    if (
      value.boundary.x + value.boundary.width > 1 ||
      value.boundary.y + value.boundary.height > 1 ||
      value.source_width_px * value.source_height_px > 24_000_000 ||
      (value.shape === 'round' && value.width_mm !== value.depth_mm)
    ) {
      ctx.addIssue({ code: 'custom', message: 'Invalid plate shape, dimensions or boundary' });
    }
  });
export type PlateCalibration = z.infer<typeof PlateCalibrationSchema>;

export type ServingDimensions = Pick<PlateCalibration, 'shape' | 'width_mm' | 'depth_mm'>;

// Screen 9 labels this input in cm. Text is never measurement evidence by itself:
// actual-size placement also requires the confirmed boundary on the exact photo.
export function parseServingDimensions(
  value: string | null | undefined,
): ServingDimensions | undefined {
  if (typeof value !== 'string' || value.length > 160) return undefined;
  const match = /^(\d{1,3}(?:\.\d)?)\s*(?:cm)?(?:\s*[x×]\s*(\d{1,3}(?:\.\d)?)\s*(?:cm)?)?$/i.exec(
    value.trim(),
  );
  if (!match) return undefined;
  const width = Math.round(Number(match[1]) * 10);
  const depth = match[2] === undefined ? width : Math.round(Number(match[2]) * 10);
  if (width < 30 || width > 1000 || depth < 30 || depth > 1000) return undefined;
  return {
    shape: match[2] === undefined ? 'round' : 'rectangular',
    width_mm: width,
    depth_mm: depth,
  };
}

export function servingDimensionsMatch(
  value: string | null | undefined,
  calibration: ServingDimensions | null | undefined,
): boolean {
  const dimensions = parseServingDimensions(value);
  return Boolean(
    dimensions &&
      calibration &&
      dimensions.shape === calibration.shape &&
      dimensions.width_mm === calibration.width_mm &&
      dimensions.depth_mm === calibration.depth_mm,
  );
}

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
    physical_size: z
      .strictObject({
        serving_count: ServingCountSchema.optional(),
        plate: PlateCalibrationSchema,
        foreground_sha256: z.string().regex(/^[a-f0-9]{64}$/),
        source: z.literal('owner'),
        validation_status: z.literal('pending'),
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
    const measured = value.physical_size;
    if (
      measured &&
      (value.layers.filter((layer) => layer.depth > 0).length !== 1 ||
        value.layers.find((layer) => layer.depth > 0)?.sha256 !== measured.foreground_sha256 ||
        Math.abs(
          value.width * measured.plate.source_height_px -
            value.height * measured.plate.source_width_px,
        ) >
          measured.plate.source_width_px + measured.plate.source_height_px)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Calibration must match the rendered foreground and source aspect ratio',
      });
    }
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
