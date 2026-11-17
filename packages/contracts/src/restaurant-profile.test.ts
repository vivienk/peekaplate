import { describe, expect, it } from 'vitest';
import { RestaurantDetailsSchema, SaveRestaurantProfileSchema } from './restaurant-profile';

const fields = {
  name: 'Ember & Stone',
  city: 'San Francisco',
  street: '1 Example Street',
  line2: '',
  phone: '+1 (415) 555-0100',
  email: 'owner@example.test',
  photoId: null,
};
describe('restaurant profile boundary', () => {
  it('accepts the authored S05 fields and keeps verification server-owned', () => {
    const command = {
      commandId: '00000000-0000-4000-8000-000000000001',
      expectedVersion: 0,
      fields,
    };
    expect(SaveRestaurantProfileSchema.parse(command).fields).toEqual(fields);
    expect(SaveRestaurantProfileSchema.safeParse({ ...command, verified: true }).success).toBe(
      false,
    );
  });
  it('rejects invalid contact fields and database text', () => {
    const { photoId: _photoId, ...details } = fields;
    for (const change of [
      { name: '' },
      { name: 'bad\u0000name' },
      { phone: '123' },
      { email: 'wrong' },
      { city: 'x'.repeat(161) },
    ])
      expect(RestaurantDetailsSchema.safeParse({ ...details, ...change }).success).toBe(false);
  });
});
