import { PublicPortionSchema } from '@peekaplate/contracts';
import { describe, expect, it } from 'vitest';
import { toMenu } from './adapter';
import { demoBundle, FIXTURE_PUBLICATION_REVISION_ID } from './fixtures';

const dish = demoBundle.categories[0]?.dishes[0];
if (!dish?.complete) throw new Error('Expected complete fixture');
const portion = {
  schema_version: 1 as const,
  dish_id: dish.dish_id,
  dish_revision_id: dish.dish_revision_id,
  width: 64,
  height: 64,
  layers: [0, 1].map((depth) => ({
    url: `https://assets.example.test/${depth}.png`,
    sha256: 'a'.repeat(64),
    size_bytes: 100,
    depth,
  })),
};

function adapt(value: unknown) {
  const bundle = structuredClone(demoBundle);
  Object.assign(bundle.categories[0]?.dishes[0] ?? {}, { portion: value });
  const result = toMenu(bundle, 'fixture', FIXTURE_PUBLICATION_REVISION_ID);
  if (result.status !== 'ready') throw new Error('Menu not ready');
  const resultDish = result.menu.categories[0]?.dishes[0];
  if (resultDish?.kind !== 'complete') throw new Error('Dish not complete');
  return resultDish;
}

describe('portion handoff', () => {
  it('copies only a valid asset for the selected dish revision', () => {
    const result = adapt(portion);
    expect(result.portion).toEqual(portion);
    expect(result.portion).not.toBe(portion);
    expect(
      adapt({ ...portion, dish_id: '00000000-0000-4000-8000-000000000099' }).portion,
    ).toBeUndefined();
    expect(
      adapt({ ...portion, dish_revision_id: '00000000-0000-4000-8000-000000000099' }).portion,
    ).toBeUndefined();
  });
  it.each([
    undefined,
    null,
    {},
    { ...portion, review: { status: 'needs_review' } },
    { ...portion, layers: [portion.layers[0]] },
    { ...portion, layers: portion.layers.map((layer) => ({ ...layer, depth: 0 })) },
    { ...portion, layers: portion.layers.map((layer) => ({ ...layer, size_bytes: 180_000 })) },
    {
      ...portion,
      layers: portion.layers.map((layer) => ({ ...layer, url: 'javascript:alert(1)' })),
    },
  ])('keeps the dish usable without malformed/missing assets: %j', (input) => {
    const result = adapt(input);
    expect(result.portion).toBeUndefined();
    expect(result.images).toEqual(dish.images);
  });
  it('rejects credentials, nonfinite depth and oversized textures', () => {
    expect(PublicPortionSchema.safeParse({ ...portion, width: 9999 }).success).toBe(false);
    for (const patch of [{ depth: NaN }, { url: 'https://user:pass@example.test/a.png' }]) {
      expect(
        PublicPortionSchema.safeParse({
          ...portion,
          layers: portion.layers.map((layer) => ({ ...layer, ...patch })),
        }).success,
      ).toBe(false);
    }
  });
});
