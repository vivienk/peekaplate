import { describe, expect, it } from 'vitest';
import { ApprovedDishFactsSchema, OwnerDishFieldsSchema } from './owner-menu';
import { parsePlateDimensions, parseServingCountInput, resolveServingCount } from './portion';
import {
  CandidateCorrectedFieldsSchema,
  CandidateReviewRecordSchema,
  ResolvedCandidateFieldsSchema,
} from './review-persistence';

const photoId = '11111111-1111-4111-8111-111111111111';
const calibration = {
  shape: 'round' as const,
  width_mm: 280,
  depth_mm: 280,
  source_sha256: 'a'.repeat(64),
  source_width_px: 800,
  source_height_px: 600,
  boundary: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
  confirmed: true as const,
};

describe('Screen 9 serving size counts people', () => {
  it.each([
    ['1', 1],
    ['2', 2],
    [' 12 ', 12],
    ['100', 100],
  ] as const)('reads %s as %i people without creating a physical measurement', (input, count) => {
    expect(parseServingCountInput(input)).toBe(count);
    const saved = OwnerDishFieldsSchema.parse({ servingSize: input, servingCount: count });
    expect(saved.servingCount).toBe(count);
    expect(saved).not.toHaveProperty('portionCalibration');
  });

  it.each([
    undefined,
    null,
    '',
    '0',
    '101',
    '1/2',
    '1 / 2',
    '1–2',
    '1.5',
    '1 bowl',
    '28 cm',
    '1e2',
  ])('does not invent a people count from %j', (input) =>
    expect(parseServingCountInput(input)).toBeUndefined(),
  );

  it('resolves legacy counts consistently for review and explicit approval', () => {
    expect(resolveServingCount(2, '1')).toBe(2);
    expect(resolveServingCount(null, '2')).toBeNull();
    expect(resolveServingCount(undefined, '2')).toBe(2);
    expect(resolveServingCount(undefined, '1/2')).toBeUndefined();
    expect(resolveServingCount(undefined, '1 bowl')).toBeUndefined();
    expect(resolveServingCount(undefined, '28', calibration)).toBeUndefined();
    expect(resolveServingCount(2, '28 cm', calibration)).toBe(2);
    expect(resolveServingCount(undefined, null)).toBeUndefined();
    expect(resolveServingCount(101, '2')).toBeUndefined();
    expect(resolveServingCount(1.5, '2')).toBeUndefined();
  });
});

describe('optional plate measurements are separate from serving size', () => {
  it.each([
    ['28', 'round', 280, 280],
    ['28 cm', 'round', 280, 280],
    [' 28.5 CM ', 'round', 285, 285],
    ['30 x 20', 'rectangular', 300, 200],
    ['30 × 20 cm', 'rectangular', 300, 200],
    ['30 cm x 20 cm', 'rectangular', 300, 200],
    ['3', 'round', 30, 30],
    ['100', 'round', 1000, 1000],
  ])(
    'reads %s as physical centimetres without confirming a photo',
    (input, shape, width, depth) => {
      expect(parsePlateDimensions(input as string)).toEqual({
        shape,
        width_mm: width,
        depth_mm: depth,
      });
    },
  );

  it.each([
    '',
    '1 bowl',
    '6 pieces',
    'large',
    '500 g',
    '12 in',
    '2',
    '101',
    '28.55',
    '-28',
    '1e2',
    '28 x',
    '28 x 20 x 5',
  ])('does not interpret %j as measured plate dimensions', (input) => {
    expect(parsePlateDimensions(input)).toBeUndefined();
  });

  it('requires valid confirmed photo evidence for the separate measurement', () => {
    for (const change of [
      { confirmed: false },
      { source_sha256: 'not-a-photo-hash' },
      { boundary: { x: 0.5, y: 0, width: 0.8, height: 0.8 } },
    ]) {
      expect(
        OwnerDishFieldsSchema.safeParse({ portionCalibration: { ...calibration, ...change } })
          .success,
      ).toBe(false);
    }
  });

  it('preserves a 28 cm plate independently of a two-person serving size', () => {
    const parsed = OwnerDishFieldsSchema.parse({
      servingSize: '2',
      servingCount: 2,
      photoId,
      portionCalibration: calibration,
    });
    expect(parsed).toMatchObject({
      servingSize: '2',
      servingCount: 2,
      portionCalibration: calibration,
    });
  });

  it('preserves an explicit clear without inventing measurements for legacy text', () => {
    expect(OwnerDishFieldsSchema.parse({ servingSize: '1 bowl' })).not.toHaveProperty(
      'portionCalibration',
    );
    expect(OwnerDishFieldsSchema.parse({ portionCalibration: null })).toHaveProperty(
      'portionCalibration',
      null,
    );
  });

  it('carries the same photo-bound measurement through extracted correction and response', () => {
    const fields = {
      serving_size: '2',
      serving_count: 2,
      photo_id: photoId,
      portion_calibration: calibration,
    };
    expect(CandidateCorrectedFieldsSchema.parse(fields)).toMatchObject(fields);
    expect(CandidateReviewRecordSchema.shape.corrected.parse(fields)).toMatchObject(fields);
    expect(
      ResolvedCandidateFieldsSchema.parse({
        name: 'Synthetic dish',
        description: null,
        category: null,
        price_amount: null,
        price_currency: null,
        ingredients: null,
        ...fields,
      }),
    ).toMatchObject(fields);
  });

  it('retains the serving input and measured evidence in an approved immutable revision', () => {
    expect(
      ApprovedDishFactsSchema.parse({
        category: null,
        priceAmount: null,
        priceCurrency: null,
        ingredients: null,
        allergens: null,
        photoId,
        servingSize: '2',
        servingCount: 2,
        portionCalibration: calibration,
      }),
    ).toMatchObject({ servingSize: '2', servingCount: 2, portionCalibration: calibration });
  });
});
