import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMenuRefresher } from './refresh';
import type { Menu, MenuLoadResult, MenuSource } from './types';

const MIN = 60_000;

const menu = (publicationRevisionId: string): Menu => ({
  source: 'published',
  notice: null,
  venueId: '11111111-1111-4111-8111-111111111111',
  menuId: '22222222-2222-4222-8222-222222222222',
  publicationRevisionId,
  menuRevisionId: '33333333-3333-4333-8333-333333333333',
  restaurant: { name: 'Test', logo: null },
  categories: [],
});

function setup(results: MenuLoadResult[]) {
  const load = vi.fn(async (): Promise<MenuLoadResult> => results.shift() ?? { status: 'error' });
  const source: MenuSource = { load };
  const onSwap = vi.fn();
  const onStop = vi.fn();
  const refresher = createMenuRefresher({
    source,
    getCurrent: () => menu('pub-1'),
    onSwap,
    onStop,
  });
  return { load, onSwap, onStop, refresher };
}

describe('menu refresher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-reads 5 minutes before the token expires, and not earlier', async () => {
    const { load, refresher } = setup([{ status: 'ready', menu: menu('pub-1') }]);
    refresher.schedule(30 * MIN);
    await vi.advanceTimersByTimeAsync(25 * MIN - 1);
    expect(load).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('keeps the menu when the publication is the same', async () => {
    const { onSwap, refresher } = setup([{ status: 'ready', menu: menu('pub-1') }]);
    await expect(refresher.refresh()).resolves.toBe('same');
    expect(onSwap).not.toHaveBeenCalled();
  });

  it('swaps the menu in one step when the publication changed', async () => {
    const next = menu('pub-2');
    const { onSwap, refresher } = setup([{ status: 'ready', menu: next }]);
    await expect(refresher.refresh()).resolves.toBe('swapped');
    expect(onSwap).toHaveBeenCalledTimes(1);
    expect(onSwap).toHaveBeenCalledWith(next);
  });

  it('on a 404 keeps the menu, stops event collection and stops the timer', async () => {
    const { load, onSwap, onStop, refresher } = setup([{ status: 'unavailable' }]);
    refresher.schedule(30 * MIN);
    await vi.advanceTimersByTimeAsync(25 * MIN);
    expect(load).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onSwap).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('on an error keeps the menu and retries once halfway to expiry', async () => {
    const { load, onSwap, onStop, refresher } = setup([{ status: 'error' }, { status: 'error' }]);
    refresher.schedule(30 * MIN);
    await vi.advanceTimersByTimeAsync(25 * MIN);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2.5 * MIN - 1);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(2);
    expect(onSwap).not.toHaveBeenCalled();
    expect(onStop).not.toHaveBeenCalled();
  });

  it('treats a thrown load as an error and keeps the menu', async () => {
    const load = vi.fn(async (): Promise<MenuLoadResult> => {
      throw new Error('boom');
    });
    const onSwap = vi.fn();
    const refresher = createMenuRefresher({
      source: { load },
      getCurrent: () => menu('pub-1'),
      onSwap,
      onStop: vi.fn(),
    });
    await expect(refresher.refresh()).resolves.toBe('kept');
    expect(onSwap).not.toHaveBeenCalled();
  });

  it('does nothing after stop()', async () => {
    const { load, refresher } = setup([{ status: 'ready', menu: menu('pub-2') }]);
    refresher.schedule(30 * MIN);
    refresher.stop();
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(load).not.toHaveBeenCalled();
  });
});
