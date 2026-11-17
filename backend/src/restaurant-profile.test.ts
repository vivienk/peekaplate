import { expect, it } from 'vitest';
import { replayRestaurantProfile } from './restaurant-profile';

const profile = {
  version: 1,
  status: 'submitted',
  fields: {
    name: 'Synthetic Bistro',
    city: 'Test city',
    street: 'Test street',
    line2: '',
    phone: '1234567890',
    email: '',
    photoId: null,
  },
};
it('replays the canonical profile and rejects noncontiguous or incompatible history', () => {
  const event = {
    version: 1,
    schema_version: 1,
    event_type: 'restaurant.profile.saved',
    payload: profile,
  };
  expect(replayRestaurantProfile([event])).toEqual(profile);
  expect(() => replayRestaurantProfile([event, event])).toThrow();
  expect(() =>
    replayRestaurantProfile([
      { ...event, payload: { version: 1, details: profile.fields, logo: null } },
    ]),
  ).toThrow();
});
