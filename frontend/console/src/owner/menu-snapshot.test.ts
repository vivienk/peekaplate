import { expect, it } from 'vitest';
import type { DishDraft } from '../owner-menu/api';
import { menuSnapshot } from './menu-snapshot';

const draft = {
  id: '11111111-1111-4111-8111-111111111111',
  origin: 'manual',
  review_status: 'pending',
  verification_status: 'verified',
  manual_fields: { name: 'Rice', category: 'Sides', priceAmount: '0', priceCurrency: 'USD' },
} as DishDraft;

it('unlocks from persisted verification, not the presence of drafts or local review checks', () => {
  expect(menuSnapshot('venue', [], {}, false).verified).toBe(false);
  expect(menuSnapshot('venue', [draft], {}, false).verified).toBe(true);
  expect(
    menuSnapshot('venue', [{ ...draft, verification_status: 'not_verified' }], {}, false).verified,
  ).toBe(false);
  expect(menuSnapshot('venue', [draft], {}, true).verified).toBe(false);
});

it('excludes removed/rejected drafts and keeps actual zero prices', () => {
  const result = menuSnapshot(
    'venue',
    [
      draft,
      { ...draft, id: 'removed', removed_at: '2026-11-17' },
      { ...draft, id: 'rejected', review_status: 'rejected' },
    ],
    {},
    false,
  );
  expect(result.dishes).toEqual([
    { id: draft.id, name: 'Rice', category: 'Sides', priceLabel: '$0.00' },
  ]);
});

it('does not turn absent or invalid prices into zero', () => {
  expect(
    menuSnapshot('venue', [{ ...draft, manual_fields: { name: 'Rice' } }], {}, false).dishes[0]
      ?.priceLabel,
  ).toBe('Price not set');
});
