import { describe, expect, it } from 'vitest';
import { formatPrice, PRICE_UNAVAILABLE_TEXT } from './price';

const bad = (value: unknown) => value as Parameters<typeof formatPrice>[0];

describe('formatPrice', () => {
  it('shows a dollar sign and no currency code', () => {
    expect(formatPrice({ amount: '14.00', currency: 'USD' })).toBe('$14.00');
  });
  it('keeps two decimals', () => {
    expect(formatPrice({ amount: '17.5', currency: 'USD' })).toBe('$17.50');
  });
  it('shows unavailable for an invalid currency, not a bare amount', () => {
    expect(formatPrice({ amount: '14.00', currency: 'XX' })).toBe(PRICE_UNAVAILABLE_TEXT);
  });
  it('shows unavailable for an absent currency', () => {
    expect(formatPrice(bad({ amount: '14.00' }))).toBe(PRICE_UNAVAILABLE_TEXT);
  });
  it('shows unavailable for an absent amount without throwing', () => {
    expect(formatPrice(bad({ currency: 'USD' }))).toBe(PRICE_UNAVAILABLE_TEXT);
  });
  it('shows unavailable for an empty amount', () => {
    expect(formatPrice({ amount: '  ', currency: 'USD' })).toBe(PRICE_UNAVAILABLE_TEXT);
  });
  it('shows unavailable for a non-numeric amount', () => {
    expect(formatPrice({ amount: 'abc', currency: 'USD' })).toBe(PRICE_UNAVAILABLE_TEXT);
  });
  it('shows unavailable when the whole price is missing', () => {
    expect(formatPrice(bad(undefined))).toBe(PRICE_UNAVAILABLE_TEXT);
  });
});
