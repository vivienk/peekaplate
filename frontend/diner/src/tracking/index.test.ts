import { afterEach, describe, expect, it, vi } from 'vitest';
import { track } from './index';

afterEach(() => vi.restoreAllMocks());

describe('track placeholder', () => {
  it('logs the event name and payload to the console', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    track('menu_viewed', { entry_source: 'qr' });
    expect(info).toHaveBeenCalledWith('[track]', 'menu_viewed', { entry_source: 'qr' });
  });

  it('never throws, so a tracking failure cannot break the screens', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {
      throw new Error('console unavailable');
    });
    expect(() => track('menu_viewed', {})).not.toThrow();
  });
});
