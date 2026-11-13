import { PublicPortionSchema } from '@peekaplate/contracts';
import { expect, it } from 'vitest';
import { portionWorldWidth } from './portionAR';

it('uses owner millimetres in world metres and accounts for transparent image margins', () => {
  for (const fraction of [1, 0.5, 0.25]) {
    const size = { width_mm: 280, foreground_width_fraction: fraction, source: 'owner' as const };
    expect(portionWorldWidth(size) * fraction).toBeCloseTo(0.28);
  }
});
it('accepts only bounded, owner-declared physical dimensions in the public contract', () => {
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
  const size = { width_mm: 280, foreground_width_fraction: 0.5, source: 'owner' };
  expect(PublicPortionSchema.safeParse({ ...portion, physical_size: size }).success).toBe(true);
  for (const change of [
    { width_mm: 0 },
    { width_mm: 1001 },
    { foreground_width_fraction: 0 },
    { source: 'inferred' },
  ]) {
    expect(
      PublicPortionSchema.safeParse({ ...portion, physical_size: { ...size, ...change } }).success,
    ).toBe(false);
  }
});
