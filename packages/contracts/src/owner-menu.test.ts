import { describe, expect, it } from 'vitest';
import { OwnerDishFieldsSchema, SaveOwnerDishDraftSchema } from './owner-menu';

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
});
