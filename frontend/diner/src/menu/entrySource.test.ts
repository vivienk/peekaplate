import { describe, expect, it } from 'vitest';
import { entrySourceFromSearch } from './menuScreen';

describe('entrySourceFromSearch', () => {
  it('maps ?src=qr to qr', () => {
    expect(entrySourceFromSearch('?src=qr')).toBe('qr');
  });

  it('maps an absent marker to direct_link', () => {
    expect(entrySourceFromSearch('')).toBe('direct_link');
    expect(entrySourceFromSearch('?foo=bar')).toBe('direct_link');
  });

  it('maps any other value, including an empty src, to unknown', () => {
    expect(entrySourceFromSearch('?src=')).toBe('unknown');
    expect(entrySourceFromSearch('?src=direct')).toBe('unknown');
    expect(entrySourceFromSearch('?src=foo')).toBe('unknown');
  });
});
