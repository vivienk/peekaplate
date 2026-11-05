// The dish_activity_checkpoint clock (S3-TRK-01.1; ADR 0015 D8; implementation plan, active detail
// time). Screens report deliberate input; the layer owns the timing. Active time counts only while
// the detail is visible and within 30 seconds of the last input, up to 300000 ms per opening.
// Checkpoints are cumulative (the greatest value wins, never their sum): one 5 active seconds
// after the previous checkpoint, one when the clock pauses, and a final one when the opening ends.
// Going into the back-forward cache pauses the clock (like hiding the tab) rather than ending it.
// An opening never sends into a later visit: see startOpeningClock below.
import { VISIT_TIMEOUT_MS } from './identity';

export const CHECKPOINT_EVERY_MS = 5_000;
export const IDLE_PAUSE_MS = 30_000;
export const OPENING_CAP_MS = 300_000;

export type PageVisibility = {
  isVisible(): boolean;
  onChange(fn: () => void): () => void;
  // persisted is true when the page goes into the back-forward cache and may come back.
  onPageHide(fn: (persisted: boolean) => void): () => void;
  // Called when the page comes back from the back-forward cache.
  onPageRestore(fn: () => void): () => void;
};

export type OpeningFields = {
  publication_revision_id: string;
  dish_id: string;
  dish_revision_id: string;
  opening_id: string;
};

type Send = (eventName: string, payload: Record<string, unknown>) => void;

export function browserVisibility(): PageVisibility {
  return {
    isVisible: () => document.visibilityState === 'visible',
    onChange: (fn) => {
      document.addEventListener('visibilitychange', fn);
      return () => document.removeEventListener('visibilitychange', fn);
    },
    onPageHide: (fn) => {
      const listener = (event: PageTransitionEvent) => fn(event.persisted);
      globalThis.addEventListener('pagehide', listener);
      return () => globalThis.removeEventListener('pagehide', listener);
    },
    onPageRestore: (fn) => {
      const listener = (event: PageTransitionEvent) => {
        if (event.persisted) fn();
      };
      globalThis.addEventListener('pageshow', listener);
      return () => globalThis.removeEventListener('pageshow', listener);
    },
  };
}

// Start when the readable detail appears (with its opening_id); call activity() on deliberate input
// (tap, scroll, key, drag) and end() when the detail closes.
//
// A visit ends after 30 minutes without a tracked event (identity.ts), and a checkpoint sent after
// that would carry the new visit's session_id and never join its opening. So once 30 minutes have
// passed since this opening last sent anything (its dish_detail_opened counts as the start), the
// opening is closed without sending more and onExpired is called, so a screen that is still showing
// the detail can start a new opening in the new visit. Time already counted is kept: every pause
// (idle, hidden tab, back-forward cache) sends the running total in the opening's own visit, and
// the owner report uses the greatest checkpoint. At most the last few unsent seconds (under one
// 5-second checkpoint) can be dropped, and only when the diner returns just before the timeout.
export function startOpeningClock(
  opening: OpeningFields,
  {
    send,
    visibility = browserVisibility(),
    now = () => Date.now(),
    onExpired,
  }: { send: Send; visibility?: PageVisibility; now?: () => number; onExpired?: () => void },
) {
  let accrued = 0;
  let lastSent = 0;
  let lastInput = now();
  let lastSentAt = lastInput;
  // Start of the current active stretch, or null while paused.
  let since: number | null = visibility.isVisible() ? lastInput : null;
  let ended = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function emit(final: boolean) {
    lastSent = accrued;
    lastSentAt = now();
    try {
      send('dish_activity_checkpoint', { ...opening, active_ms: accrued, final });
    } catch {}
  }

  // Bring the total up to time t; the stretch stops at the idle deadline or the cap.
  function settle(t: number) {
    if (since === null) return;
    const until = Math.min(t, lastInput + IDLE_PAUSE_MS);
    accrued = Math.min(OPENING_CAP_MS, accrued + Math.max(0, until - since));
    const stillActive = t < lastInput + IDLE_PAUSE_MS && accrued < OPENING_CAP_MS;
    since = stillActive ? t : null;
    if (!stillActive && accrued > lastSent) emit(false);
  }

  function schedule() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (ended || since === null) return;
    const toCheckpoint = lastSent + CHECKPOINT_EVERY_MS - accrued;
    const toIdle = lastInput + IDLE_PAUSE_MS - now();
    const toCap = OPENING_CAP_MS - accrued;
    timer = setTimeout(wake, Math.max(0, Math.min(toCheckpoint, toIdle, toCap)));
  }

  function wake() {
    timer = null;
    if (expired()) return;
    settle(now());
    if (since !== null && accrued - lastSent >= CHECKPOINT_EVERY_MS) emit(false);
    schedule();
  }

  function stop() {
    ended = true;
    since = null;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    stopVisibility();
    stopPageHide();
    stopPageRestore();
  }

  // True (and the opening closed quietly) when the visit this opening belongs to has timed out.
  function expired(): boolean {
    if (ended) return true;
    if (now() - lastSentAt < VISIT_TIMEOUT_MS) return false;
    stop();
    try {
      onExpired?.();
    } catch {}
    return true;
  }

  function pause() {
    settle(now());
    since = null;
    if (accrued > lastSent) emit(false);
  }

  function onVisibility() {
    if (expired()) return;
    const t = now();
    if (!visibility.isVisible()) {
      pause();
    } else if (since === null && t - lastInput < IDLE_PAUSE_MS && accrued < OPENING_CAP_MS) {
      since = t;
    }
    schedule();
  }

  function end() {
    if (expired()) return;
    settle(now());
    stop();
    emit(true);
  }

  // Leaving the page ends the opening; going into the back-forward cache only pauses it.
  function onPageHide(persisted: boolean) {
    if (!persisted) {
      end();
      return;
    }
    if (expired()) return;
    pause();
    schedule();
  }

  const stopVisibility = visibility.onChange(onVisibility);
  const stopPageHide = visibility.onPageHide(onPageHide);
  const stopPageRestore = visibility.onPageRestore(onVisibility);
  schedule();

  return {
    activity() {
      if (expired()) return;
      const t = now();
      settle(t);
      lastInput = t;
      if (since === null && visibility.isVisible() && accrued < OPENING_CAP_MS) since = t;
      schedule();
    },
    end,
  };
}
