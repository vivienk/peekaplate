import type { CompleteDish } from './types';

export const PRICE_UNAVAILABLE_TEXT = 'Price unavailable';

export function formatPrice(price: CompleteDish['price']): string {
  const { amount, currency } = price ?? {};
  if (typeof amount !== 'string' || typeof currency !== 'string') return PRICE_UNAVAILABLE_TEXT;
  const raw = amount.trim();
  const value = Number(raw);
  if (raw === '' || !Number.isFinite(value) || !/^[A-Za-z]{3}$/.test(currency)) {
    return PRICE_UNAVAILABLE_TEXT;
  }
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(value);
  } catch {
    return PRICE_UNAVAILABLE_TEXT;
  }
}
