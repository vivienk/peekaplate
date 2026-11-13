// Re-reads the published menu before its token expires (DIN-03). The first load arms the timer
// through schedule(); each successful re-read calls schedule() again, so there is no other polling.
// A new publication replaces the menu in one step. A 404 stops event collection and tells the screen
// the menu was withdrawn (onWithdrawn), so it can stop showing the old menu (S5-FE-10). Invalid data
// or a failed read keeps the current menu; token expiry only stops collection.
import type { Menu, MenuLoadResult, MenuSource } from './types';

// How long before the 30-minute token expires the re-read starts. Proposed, not yet agreed.
export const REFRESH_LEAD_MS = 5 * 60 * 1000;
// Never re-read sooner than this after being scheduled, so a clock error cannot cause a tight loop.
const MIN_DELAY_MS = 30_000;
// A retry is only attempted while at least this much of the token's life remains.
const MIN_RETRY_REMAINING_MS = 10_000;

export type RefreshOutcome = 'same' | 'swapped' | 'kept' | 'stopped';

export type MenuRefresherOptions = {
  source: MenuSource;
  getCurrent: () => Menu | null;
  // Replaces the displayed menu with the new one. Called only with a fully validated menu.
  onSwap: (menu: Menu) => void;
  // The publication is gone (404): event collection must stop. Called before onWithdrawn.
  onStop: () => void;
  // Optional (S5-FE-10). Called once, only when the server itself answered 404: the screen then stops
  // showing the old menu. Never called for errors, offline reads, invalid data or token expiry.
  onWithdrawn?: () => void;
  now?: () => number;
};

export type MenuRefresher = {
  // Arms the re-read for a token that expires at expiresAt (epoch ms). Replaces any earlier timer.
  schedule(expiresAt: number): void;
  refresh(): Promise<RefreshOutcome>;
  stop(): void;
};

export function createMenuRefresher(options: MenuRefresherOptions): MenuRefresher {
  const now = options.now ?? (() => Date.now());
  let timer: ReturnType<typeof setTimeout> | null = null;
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let running = false;
  let expiresAt = 0;

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const clearExpiry = () => {
    if (expiryTimer !== null) clearTimeout(expiryTimer);
    expiryTimer = null;
  };
  const stopCollection = () => {
    if (stopped) return;
    stopped = true;
    clear();
    clearExpiry();
    options.onStop();
  };

  const arm = (delayMs: number) => {
    clear();
    timer = setTimeout(() => {
      timer = null;
      void refresh();
    }, delayMs);
  };

  async function refresh(): Promise<RefreshOutcome> {
    if (stopped || running) return 'kept';
    running = true;
    try {
      let result: MenuLoadResult;
      try {
        result = await options.source.load();
      } catch {
        result = { status: 'error' };
      }
      if (stopped) return 'kept';

      if (result.status === 'ready') {
        const current = options.getCurrent();
        // Same publication: the token was already updated by the source; the menu is unchanged.
        if (current && result.menu.publicationRevisionId === current.publicationRevisionId) {
          return 'same';
        }
        options.onSwap(result.menu);
        return 'swapped';
      }

      if (result.status === 'unavailable') {
        stopCollection();
        options.onWithdrawn?.();
        return 'stopped';
      }

      // error, offline or empty: keep the current menu. Retry halfway to expiry while time remains.
      const remaining = expiresAt - now();
      if (remaining > MIN_RETRY_REMAINING_MS) arm(remaining / 2);
      return 'kept';
    } finally {
      running = false;
    }
  }

  return {
    schedule(at) {
      if (stopped) return;
      expiresAt = at;
      clearExpiry();
      expiryTimer = setTimeout(stopCollection, Math.max(at - now(), 0));
      arm(Math.max(at - now() - REFRESH_LEAD_MS, MIN_DELAY_MS));
    },
    refresh,
    stop() {
      stopped = true;
      clear();
      clearExpiry();
    },
  };
}
