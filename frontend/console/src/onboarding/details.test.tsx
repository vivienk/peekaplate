import { describe, expect, it } from 'vitest';
import {
  detailsChanged,
  detailsErrors,
  EMPTY_DETAILS,
  fieldError,
  photoError,
  REQUIRED_FIELDS,
} from './details';

const FILLED = {
  name: 'Ember & Stone',
  city: 'San Francisco',
  street: '742 Evergreen Terrace',
  line2: '',
  phone: '(555) 234-5678',
  email: '',
};

describe('S05 restaurant details checks (FE-05)', () => {
  it('requires name, city, street address and phone, with the Figma wording', () => {
    expect(REQUIRED_FIELDS).toEqual(['name', 'city', 'street', 'phone']);
    expect(detailsErrors(EMPTY_DETAILS)).toEqual({
      name: 'Enter your restaurant name',
      city: 'Enter your city',
      street: 'Enter your street address',
      phone: 'Enter your phone number',
    });
    expect(detailsErrors(FILLED)).toEqual({});
  });

  it('checks the phone number format', () => {
    expect(fieldError('phone', '12')).toBe('Enter a valid phone number');
    expect(fieldError('phone', 'call me')).toBe('Enter a valid phone number');
    expect(fieldError('phone', '+44 20 7946 0958')).toBeUndefined();
  });

  it('lets the contact email be empty, but not invalid', () => {
    expect(fieldError('email', '')).toBeUndefined();
    expect(fieldError('email', 'owner@')).toBe('Enter a valid email address');
    expect(fieldError('email', 'owner@emberandstone.com')).toBeUndefined();
  });

  it('treats spaces-only changes as no change', () => {
    expect(detailsChanged(FILLED, { ...FILLED, city: ' San Francisco ' })).toBe(false);
    expect(detailsChanged(FILLED, { ...FILLED, city: 'Oakland' })).toBe(true);
  });

  it('accepts a JPEG or PNG photo up to 12 MB', () => {
    const file = (type: string, size: number) =>
      new File([new Uint8Array(1)], 'photo', { type }) as File & { size: number };
    expect(photoError(file('image/png', 1))).toBeUndefined();
    expect(photoError(file('image/gif', 1))).toBe('Choose a JPEG or PNG image');
    const big = file('image/jpeg', 1);
    Object.defineProperty(big, 'size', { value: 12_000_001 });
    expect(photoError(big)).toBe('Choose an image up to 12 MB');
  });
});
