import { PublicPortionSchema } from '@peekaplate/contracts';
import { expect, it } from 'vitest';
import { portionWorldWidth } from './portionAR';
import { approximatePortionLabel, sizeForServing } from './portionSize';

const plate = {
  shape: 'round' as const,
  width_mm: 280,
  depth_mm: 280,
  source_sha256: 'b'.repeat(64),
  source_width_px: 640,
  source_height_px: 640,
  boundary: { x: 0.2, y: 0.1, width: 0.6, height: 0.7 },
  confirmed: true as const,
};
const size = {
  plate,
  foreground_sha256: 'a'.repeat(64),
  source: 'owner' as const,
  validation_status: 'pending' as const,
};
const portion = {
  schema_version: 1,
  dish_id: '11111111-1111-4111-8111-111111111111',
  dish_revision_id: '22222222-2222-4222-8222-222222222222',
  width: 640,
  height: 640,
  layers: [0, 1].map((depth) => ({
    url: `https://example.com/${depth}.webp`,
    depth,
    sha256: 'a'.repeat(64),
    size_bytes: 100,
  })),
};
it('scales the plate boundary, independent of garnish or transparent margins', () => {
  for (const fraction of [1, 0.5, 0.25])
    expect(
      portionWorldWidth({
        ...size,
        plate: { ...plate, boundary: { ...plate.boundary, width: fraction } },
      }) * fraction,
    ).toBeCloseTo(0.28);
  expect(portionWorldWidth()).toBe(0.3);
});
it('binds calibration to the foreground and original photo coordinate system', () => {
  expect(PublicPortionSchema.safeParse({ ...portion, physical_size: size }).success).toBe(true);
  for (const change of [
    { foreground_sha256: 'c'.repeat(64) },
    { plate: { ...plate, confirmed: false } },
    { plate: { ...plate, width_mm: 0 } },
    { plate: { ...plate, depth_mm: 300 } },
    { plate: { ...plate, boundary: { ...plate.boundary, width: 0.9 } } },
    { plate: { ...plate, source_height_px: 200 } },
  ]) {
    expect(
      PublicPortionSchema.safeParse({ ...portion, physical_size: { ...size, ...change } }).success,
    ).toBe(false);
  }
  expect(
    PublicPortionSchema.safeParse({
      ...portion,
      physical_size: { width_mm: 280, foreground_width_fraction: 0.5, source: 'owner' },
    }).success,
  ).toBe(false);
});

it('uses only the matching serving calibration and never multiplies dimensions by people', () => {
  for (const count of [1, 2]) {
    const calibrated = { ...size, serving_count: count };
    expect(
      portionWorldWidth(sizeForServing({ physical_size: calibrated }, count)) *
        plate.boundary.width,
    ).toBeCloseTo(0.28);
    expect(sizeForServing({ physical_size: calibrated }, count + 1)).toBeUndefined();
    expect(sizeForServing({ physical_size: calibrated }, undefined)).toBeUndefined();
  }
  expect(sizeForServing({ physical_size: size }, 1)).toBeUndefined();
  expect(sizeForServing({}, 1)).toBeUndefined();
  expect(approximatePortionLabel(2)).toBe(
    'Serves 2 people · Approximate 2.5D preview — not actual size.',
  );
});

it('uses confirmed physical dimensions when people served is left unknown', () => {
  expect(sizeForServing({ physical_size: size })).toBe(size);
  expect(sizeForServing({ physical_size: { ...size, serving_count: 2 } })).toBeUndefined();
  expect(sizeForServing({ physical_size: size }, 2)).toBeUndefined();
  expect(approximatePortionLabel(undefined, { physical_size: size })).toBe(
    'Plate size: 28 × 28 cm · Approximate 2.5D preview — not actual size.',
  );
  expect(approximatePortionLabel(2, { physical_size: size })).not.toContain('28');
});

it('labels a two-person serving separately from its 28 cm plate', () => {
  expect(approximatePortionLabel(2, { physical_size: { ...size, serving_count: 2 } })).toBe(
    'Serves 2 people · Plate size: 28 × 28 cm · Approximate 2.5D preview — not actual size.',
  );
});
