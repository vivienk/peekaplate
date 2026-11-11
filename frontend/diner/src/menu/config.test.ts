import { describe, expect, it } from 'vitest';
import { menuMode } from './config';

describe('menuMode', () => {
  it('is live only for the exact value "live"', () => {
    expect(menuMode('live')).toBe('live');
  });
  it('defaults to fixture for anything else', () => {
    for (const value of [undefined, '', 'fixture', 'LIVE', 'true', 1, null]) {
      expect(menuMode(value)).toBe('fixture');
    }
  });
});
