import { describe, expect, it } from 'vitest';
import {
  ApproveDraftPhotoSchema,
  DishVerificationStatusSchema,
  OwnerDishFieldsSchema,
  PhotoVerificationStatusSchema,
  SaveOwnerDishDraftSchema,
  VerifyDishDraftSchema,
} from './owner-menu';

describe('owner working drafts', () => {
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
