import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  ApproveDraftPhotoSchema,
  DishVerificationStatusSchema,
  OwnerDishFieldsSchema,
  PhotoVerificationStatusSchema,
  type SaveOwnerDishDraft,
  SaveOwnerDishDraftSchema,
  VerifyDishDraftSchema,
} from './owner-menu';

describe('owner working drafts', () => {
  it('preserves the authored serving-size field without inventing it for old drafts', () => {
    expect(OwnerDishFieldsSchema.parse({ servingSize: '1 bowl' }).servingSize).toBe('1 bowl');
    expect(OwnerDishFieldsSchema.parse({}).servingSize).toBeUndefined();
    expect(OwnerDishFieldsSchema.safeParse({ servingSize: '\u0000' }).success).toBe(false);
  });
  it('keeps legacy serving fields absent while preserving explicit clears in save requests', () => {
    expectTypeOf<{}>().toExtend<
      Pick<SaveOwnerDishDraft['fields'], 'servingSize' | 'servingCount'>
    >();
    const command = { commandId: crypto.randomUUID(), expectedVersion: 1, fields: {} };
    const legacy = SaveOwnerDishDraftSchema.parse(command);
    expect(legacy.fields).not.toHaveProperty('servingSize');
    expect(legacy.fields).not.toHaveProperty('servingCount');
    expect(
      SaveOwnerDishDraftSchema.parse({
        ...command,
        fields: { servingSize: null, servingCount: null },
      }).fields,
    ).toMatchObject({ servingSize: null, servingCount: null });
  });
  it('limits owner dietary choices to two distinct public codes and keeps explicit clears', () => {
    expect(OwnerDishFieldsSchema.parse({})).not.toHaveProperty('dietary');
    expect(OwnerDishFieldsSchema.parse({ dietary: [] }).dietary).toEqual([]);
    expect(OwnerDishFieldsSchema.parse({ dietary: ['vegan', 'gluten-free'] }).dietary).toEqual([
      'vegan',
      'gluten-free',
    ]);
    for (const dietary of [
      ['vegan', 'vegan'],
      ['vegan', 'vegetarian', 'gluten-free'],
      ['unverified'],
    ])
      expect(OwnerDishFieldsSchema.safeParse({ dietary }).success).toBe(false);
  });

  it('permits incomplete saved work but never invents confirmed ingredients or allergens', () => {
    const fields = OwnerDishFieldsSchema.parse({});
    expect(fields.name).toBeNull();
    expect(fields.ingredients).toEqual({ status: 'unknown', items: [] });
    expect(fields.allergens).toEqual({ status: 'unknown', items: [] });
    expect(
      OwnerDishFieldsSchema.safeParse({ allergens: { status: 'unknown', items: ['milk'] } })
        .success,
    ).toBe(false);
  });
  it('bounds money, fields and command identity; rejects browser tenant authority', () => {
    const input = { commandId: crypto.randomUUID(), expectedVersion: 0, fields: {} };
    expect(SaveOwnerDishDraftSchema.safeParse(input).success).toBe(true);
    expect(
      SaveOwnerDishDraftSchema.safeParse({ ...input, tenantId: crypto.randomUUID() }).success,
    ).toBe(false);
    expect(OwnerDishFieldsSchema.safeParse({ priceAmount: '1.001' }).success).toBe(false);
    expect(OwnerDishFieldsSchema.safeParse({ name: '\u0000' }).success).toBe(false);
  });

  it('enforces strict verification status schemas', () => {
    expect(DishVerificationStatusSchema.safeParse('not_verified').success).toBe(true);
    expect(DishVerificationStatusSchema.safeParse('verified').success).toBe(true);
    expect(DishVerificationStatusSchema.safeParse('rejected').success).toBe(false);

    expect(PhotoVerificationStatusSchema.safeParse('not_verified').success).toBe(true);
    expect(PhotoVerificationStatusSchema.safeParse('verified').success).toBe(true);
    expect(PhotoVerificationStatusSchema.safeParse('rejected').success).toBe(true);
    expect(PhotoVerificationStatusSchema.safeParse('invalid').success).toBe(false);

    const commandId = crypto.randomUUID();
    expect(VerifyDishDraftSchema.safeParse({ commandId }).success).toBe(false);
    expect(VerifyDishDraftSchema.parse({ commandId, expectedVersion: 1 }).verified).toBe(true);
    expect(
      VerifyDishDraftSchema.safeParse({ commandId, expectedVersion: 1, verified: false }).success,
    ).toBe(true);
    expect(VerifyDishDraftSchema.safeParse({ commandId: 'not-a-uuid' }).success).toBe(false);

    expect(ApproveDraftPhotoSchema.safeParse({ commandId }).success).toBe(true);
    expect(ApproveDraftPhotoSchema.safeParse({ commandId, extra: true }).success).toBe(false);
  });
});
