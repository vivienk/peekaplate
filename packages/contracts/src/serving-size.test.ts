import { describe, expect, it } from 'vitest';
import { ApprovedDishFactsSchema, OwnerDishFieldsSchema } from './owner-menu';
import { parseServingDimensions, servingDimensionsMatch } from './portion';
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

describe('Screen 9 physical serving size', () => {
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
      expect(parseServingDimensions(input as string)).toEqual({
        shape,
        width_mm: width,
        depth_mm: depth,
      });
      expect(OwnerDishFieldsSchema.parse({ servingSize: input })).not.toHaveProperty(
        'portionCalibration',
      );
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
    expect(parseServingDimensions(input)).toBeUndefined();
  });

  it('requires the physical input and confirmed photo dimensions to agree', () => {
    expect(servingDimensionsMatch('28 cm', calibration)).toBe(true);
    expect(servingDimensionsMatch('32 cm', calibration)).toBe(false);
    expect(servingDimensionsMatch('28 x 28 cm', calibration)).toBe(false);
    expect(servingDimensionsMatch('1 bowl', calibration)).toBe(false);
    expect(servingDimensionsMatch('28 cm', null)).toBe(false);
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

  it('preserves confirmed measurements independently of the optional people count', () => {
    const parsed = OwnerDishFieldsSchema.parse({
      servingSize: '28 cm',
      photoId,
      portionCalibration: calibration,
    });
    expect(parsed).toMatchObject({ servingSize: '28 cm', portionCalibration: calibration });
    expect(parsed).not.toHaveProperty('servingCount');
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
    const fields = { serving_size: '28 cm', photo_id: photoId, portion_calibration: calibration };
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
        servingSize: '28 cm',
        portionCalibration: calibration,
      }),
    ).toMatchObject({ servingSize: '28 cm', portionCalibration: calibration });
  });
});
