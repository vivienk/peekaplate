import type { CompleteDish } from './types';

export function formatPrice(price: CompleteDish['price']): string {
  const raw = price.amount.trim();
  const amount = Number(raw);
  if (raw === '' || !Number.isFinite(amount)) return price.amount;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: price.currency,
    }).format(amount);
  } catch {
    return price.amount;
  }
}
