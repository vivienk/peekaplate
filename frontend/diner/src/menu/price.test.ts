import { describe, expect, it } from 'vitest';
import { formatPrice } from './price';

describe('formatPrice', () => {
  it('shows a dollar sign and no currency code', () => {
    expect(formatPrice({ amount: '14.00', currency: 'USD' })).toBe('$14.00');
  });
  it('keeps two decimals', () => {
    expect(formatPrice({ amount: '17.5', currency: 'USD' })).toBe('$17.50');
  });
  it('falls back to the plain amount for an invalid currency', () => {
    expect(formatPrice({ amount: '14.00', currency: 'XX' })).toBe('14.00');
  });
});
