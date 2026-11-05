import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isAllowedEvent, P0_EVENT_NAMES } from './event-names';
import { P0_EVENT_NAMES as FROM_POSTHOG } from './posthog';

describe('P0 event names', () => {
  it('accepts exactly the eight P0 names', () => {
    expect(P0_EVENT_NAMES).toHaveLength(8);
    for (const name of P0_EVENT_NAMES) expect(isAllowedEvent(name)).toBe(true);
  });

  it('rejects near-misses and names not adopted for P0', () => {
    for (const name of ['dish_detail_closed', 'Dish_Viewed', 'dish_viewed ', 'menu_view', ''])
      expect(isAllowedEvent(name)).toBe(false);
  });

  it('is the same list the PostHog adapter uses', () => {
    expect(FROM_POSTHOG).toBe(P0_EVENT_NAMES);
  });

  it('imports nothing, so importing it never pulls in PostHog or contract code', () => {
    const source = readFileSync(new URL('./event-names.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
  });
});
