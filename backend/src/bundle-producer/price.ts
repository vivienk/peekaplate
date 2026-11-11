export type NormalizedPrice =
  | { ok: true; amount: string }
  | { ok: false; reason: 'price_missing' | 'price_not_representable' };

/**
 * Converts an approved decimal string (PostgreSQL numeric text or a RES-01.2 correction) to the
 * Bundle v1 two-decimal form with string arithmetic only: "12.5" -> "12.50", "12" -> "12.00",
 * "12.5000" -> "12.50". More than two significant decimals or more than eight integer digits
 * cannot be represented without changing the approved value.
 */
export function normalizePrice(amount: string | null): NormalizedPrice {
  if (amount === null) return { ok: false, reason: 'price_missing' };
  const match = /^(\d+)(?:\.(\d+))?$/.exec(amount);
  if (!match) return { ok: false, reason: 'price_not_representable' };
  const integer = (match[1] ?? '').replace(/^0+(?=\d)/, '');
  const fraction = (match[2] ?? '').replace(/0+$/, '');
  if (integer.length > 8 || fraction.length > 2) {
    return { ok: false, reason: 'price_not_representable' };
  }
  return { ok: true, amount: `${integer}.${fraction.padEnd(2, '0')}` };
}
