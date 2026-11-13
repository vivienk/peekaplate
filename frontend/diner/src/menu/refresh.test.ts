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

  // S5-FE-10: a confirmed 404 is the only server report that the menu is gone. It must reach the
  // screen so the old menu stops being shown; errors, offline and token expiry must not.
  describe('onWithdrawn (S5-FE-10)', () => {
    function withdrawable(results: MenuLoadResult[]) {
      const load = vi.fn(
        async (): Promise<MenuLoadResult> => results.shift() ?? { status: 'error' },
      );
      const onStop = vi.fn();
      const onWithdrawn = vi.fn();
      const refresher = createMenuRefresher({
        source: { load },
        getCurrent: () => menu('pub-1'),
        onSwap: vi.fn(),
        onStop,
        onWithdrawn,
      });
      return { load, onStop, onWithdrawn, refresher };
    }

    it('calls onWithdrawn once after stopping collection when the server answers 404', async () => {
      const order: string[] = [];
      const refresher = createMenuRefresher({
        source: { load: async () => ({ status: 'unavailable' }) },
        getCurrent: () => menu('pub-1'),
        onSwap: vi.fn(),
        onStop: () => order.push('stop'),
        onWithdrawn: () => order.push('withdrawn'),
      });
      await expect(refresher.refresh()).resolves.toBe('stopped');
      await expect(refresher.refresh()).resolves.toBe('kept');
      expect(order).toEqual(['stop', 'withdrawn']);
    });

    it('does not call onWithdrawn for an error, offline or empty read', async () => {
      const { onWithdrawn, onStop, refresher } = withdrawable([
        { status: 'error' },
        { status: 'offline' },
        { status: 'empty' },
      ]);
      for (let index = 0; index < 3; index++) {
        await expect(refresher.refresh()).resolves.toBe('kept');
      }
      expect(onWithdrawn).not.toHaveBeenCalled();
      expect(onStop).not.toHaveBeenCalled();
    });

    it('does not call onWithdrawn when a thrown load becomes an error', async () => {
      const onWithdrawn = vi.fn();
      const refresher = createMenuRefresher({
        source: {
          load: async () => {
            throw new Error('boom');
          },
        },
        getCurrent: () => menu('pub-1'),
        onSwap: vi.fn(),
        onStop: vi.fn(),
        onWithdrawn,
      });
      await refresher.refresh();
      expect(onWithdrawn).not.toHaveBeenCalled();
    });

    it('does not call onWithdrawn when the token merely expires', async () => {
      const { onStop, onWithdrawn, refresher } = withdrawable([]);
      const hung = createMenuRefresher({
        source: { load: () => new Promise(() => {}) },
        getCurrent: () => menu('pub-1'),
        onSwap: vi.fn(),
        onStop,
        onWithdrawn,
      });
      hung.schedule(30 * MIN);
      refresher.stop();
      await vi.advanceTimersByTimeAsync(30 * MIN);
      expect(onStop).toHaveBeenCalledOnce();
      expect(onWithdrawn).not.toHaveBeenCalled();
    });

    it('does not call onWithdrawn for a replacement or the same publication', async () => {
      const { onWithdrawn, refresher } = withdrawable([
        { status: 'ready', menu: menu('pub-2') },
        { status: 'ready', menu: menu('pub-1') },
      ]);
      await expect(refresher.refresh()).resolves.toBe('swapped');
      await expect(refresher.refresh()).resolves.toBe('same');
      expect(onWithdrawn).not.toHaveBeenCalled();
    });

    it('is optional: a 404 still stops collection without it', async () => {
      const { onStop, refresher } = setup([{ status: 'unavailable' }]);
      await expect(refresher.refresh()).resolves.toBe('stopped');
      expect(onStop).toHaveBeenCalledOnce();
    });

    it('calls onRecovered only when a re-read succeeds on the same publication', async () => {
      const results: MenuLoadResult[] = [
        { status: 'error' },
        { status: 'ready', menu: menu('pub-1') },
        { status: 'ready', menu: menu('pub-2') },
      ];
      const onRecovered = vi.fn();
      const refresher = createMenuRefresher({
        source: { load: async () => results.shift() ?? { status: 'error' } },
        getCurrent: () => menu('pub-1'),
        onSwap: vi.fn(),
        onStop: vi.fn(),
        onRecovered,
      });
      await refresher.refresh();
      expect(onRecovered).not.toHaveBeenCalled();
      await expect(refresher.refresh()).resolves.toBe('same');
      expect(onRecovered).toHaveBeenCalledOnce();
      await expect(refresher.refresh()).resolves.toBe('swapped');
      expect(onRecovered).toHaveBeenCalledOnce();
    });
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

  it('stops collection at expiry even when the refresh request never finishes', async () => {
    const onStop = vi.fn();
    const refresher = createMenuRefresher({
      source: { load: () => new Promise(() => {}) },
      getCurrent: () => menu('pub-1'),
      onSwap: vi.fn(),
      onStop,
    });
    refresher.schedule(30 * MIN);
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(onStop).toHaveBeenCalledOnce();
  });

  it('replaces the old expiry deadline when a fresh verified token arrives', async () => {
    const { onStop, refresher } = setup([]);
    refresher.schedule(30 * MIN);
    await vi.advanceTimersByTimeAsync(20 * MIN);
    refresher.schedule(50 * MIN);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(onStop).not.toHaveBeenCalled();
    refresher.stop();
    await vi.advanceTimersByTimeAsync(50 * MIN);
    expect(onStop).not.toHaveBeenCalled();
  });
});
