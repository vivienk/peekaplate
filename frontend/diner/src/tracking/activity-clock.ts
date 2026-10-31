// The dish_activity_checkpoint clock (S3-TRK-01.1; ADR 0015 D8; implementation plan, active detail
// time). Screens report deliberate input; the layer owns the timing. Active time counts only while
// the detail is visible and within 30 seconds of the last input, up to 300000 ms per opening.
// Checkpoints are cumulative (the greatest value wins, never their sum): one 5 active seconds
// after the previous checkpoint, one when the clock pauses, and a final one when the opening ends.
export const CHECKPOINT_EVERY_MS = 5_000;
export const IDLE_PAUSE_MS = 30_000;
export const OPENING_CAP_MS = 300_000;

export type PageVisibility = {
  isVisible(): boolean;
  onChange(fn: () => void): () => void;
  onPageHide(fn: () => void): () => void;
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
      globalThis.addEventListener('pagehide', fn);
      return () => globalThis.removeEventListener('pagehide', fn);
    },
  };
}

// Start when the readable detail appears (with its opening_id); call activity() on deliberate input
// (tap, scroll, key, drag) and end() when the detail closes.
export function startOpeningClock(
  opening: OpeningFields,
  {
    send,
    visibility = browserVisibility(),
    now = () => Date.now(),
  }: { send: Send; visibility?: PageVisibility; now?: () => number },
) {
  let accrued = 0;
  let lastSent = 0;
  let lastInput = now();
  // Start of the current active stretch, or null while paused.
  let since: number | null = visibility.isVisible() ? lastInput : null;
  let ended = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function emit(final: boolean) {
    lastSent = accrued;
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
    settle(now());
    if (since !== null && accrued - lastSent >= CHECKPOINT_EVERY_MS) emit(false);
    schedule();
  }

  function onVisibility() {
    if (ended) return;
    const t = now();
    if (!visibility.isVisible()) {
      settle(t);
      since = null;
      if (accrued > lastSent) emit(false);
    } else if (since === null && t - lastInput < IDLE_PAUSE_MS && accrued < OPENING_CAP_MS) {
      since = t;
    }
    schedule();
  }

  function end() {
    if (ended) return;
    settle(now());
    ended = true;
    since = null;
    if (timer !== null) clearTimeout(timer);
    stopVisibility();
    stopPageHide();
    emit(true);
  }

  const stopVisibility = visibility.onChange(onVisibility);
  const stopPageHide = visibility.onPageHide(end);
  schedule();

  return {
    activity() {
      if (ended) return;
      const t = now();
      settle(t);
      lastInput = t;
      if (since === null && visibility.isVisible() && accrued < OPENING_CAP_MS) since = t;
      schedule();
    },
    end,
  };
}
