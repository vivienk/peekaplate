// Groups outbox events into small batches and hands them to the sender (S3-TRK-01.2). Limits follow
// the ingestion contract (ObservationBatchV2Schema, PR #70; confirmed by Zhiliang): 1 to 25 events
// and at most 32,768 bytes for the whole JSON request body, both at once. Flushes every 5 seconds
// (matrix v0.1h; implementation plan), as soon as a full batch is waiting, and when the page is
// hidden or closed; waits while offline and releases on reconnect. Events leave the outbox only when the sender reports them handled, so a
// failure keeps them for the next try. Sending itself, receipts and retries are TRK-01.3.
import type { Envelope } from './envelope';
import type { Outbox } from './outbox';

export const BATCH_MAX_ITEMS = 25;
export const BATCH_MAX_BYTES = 32 * 1024;
export const FLUSH_EVERY_MS = 5_000;

// Returns the event_ids that were handled (accepted or permanently rejected).
export type Deliver = (batch: Envelope[]) => Promise<string[]>;

export type BatchTriggers = {
  isOnline(): boolean;
  onHidden(fn: () => void): () => void;
  onOnline(fn: () => void): () => void;
};

export function browserBatchTriggers(): BatchTriggers {
  return {
    isOnline: () => globalThis.navigator?.onLine ?? true,
    // Optional calls: outside a browser (tests, server rendering) there are no page events.
    onHidden: (fn) => {
      const onVisibility = () => {
        if (globalThis.document?.visibilityState === 'hidden') fn();
      };
      globalThis.document?.addEventListener('visibilitychange', onVisibility);
      globalThis.addEventListener?.('pagehide', fn);
      return () => {
        globalThis.document?.removeEventListener('visibilitychange', onVisibility);
        globalThis.removeEventListener?.('pagehide', fn);
      };
    },
    onOnline: (fn) => {
      globalThis.addEventListener?.('online', fn);
      return () => globalThis.removeEventListener?.('online', fn);
    },
  };
}

const encoder = new TextEncoder();
// Measured on the full request body, wrapper included, exactly as the server counts it.
export const batchBody = (events: Envelope[]) => ({ contract: 'observation.v2', events }) as const;
const bodySize = (batch: Envelope[]) => encoder.encode(JSON.stringify(batchBody(batch))).byteLength;

// Oldest first, up to 25 events and 32,768 bytes. A single oversized event still goes alone, so the
// sender can handle the server's 413 for it (TRK-01.3).
function nextBatch(pending: Envelope[]): Envelope[] {
  const batch: Envelope[] = [];
  for (const event of pending) {
    if (batch.length === BATCH_MAX_ITEMS) break;
    if (batch.length > 0 && bodySize([...batch, event]) > BATCH_MAX_BYTES) break;
    batch.push(event);
  }
  return batch;
}

// A batch is full when it reached 25 events, or when the next waiting event no longer fits in it.
function isFull(pending: Envelope[]): boolean {
  const batch = nextBatch(pending);
  return batch.length === BATCH_MAX_ITEMS || pending.length > batch.length;
}

export function createBatcher(
  outbox: Outbox,
  {
    deliver,
    triggers,
    now = () => Date.now(),
  }: { deliver: Deliver; triggers: BatchTriggers; now?: () => number },
) {
  let flushing = false;
  let stopped = false;
  // Retry pause (agreed with Ehab and Jeffin, 3 Nov): TRK-01.3 delivery calls pauseUntil after a
  // failed send, e.g. Date.now() + retryDelayMs(attempt, retryAfterMs), so a 429's Retry-After is
  // honoured. While paused, every trigger skips sending; events keep queuing in the outbox.
  let pausedUntil = 0;
  let resumeTimer: ReturnType<typeof setTimeout> | undefined;

  async function flush() {
    if (stopped || flushing || !triggers.isOnline() || now() < pausedUntil) return;
    flushing = true;
    try {
      const batch = nextBatch(await outbox.pending());
      if (stopped || !triggers.isOnline() || now() < pausedUntil || batch.length === 0) return;
      const handled = await deliver(batch);
      if (stopped) return;
      const submitted = new Set(batch.map((event) => event.event_id));
      await outbox.remove(handled.filter((id) => submitted.has(id)));
    } catch {
      // Kept for the next flush; the diner never sees a delivery failure.
    } finally {
      flushing = false;
    }
  }

  const run = () => {
    void flush();
  };
  const timer = setInterval(run, FLUSH_EVERY_MS);
  const stopHidden = triggers.onHidden(run);
  const stopOnline = triggers.onOnline(run);

  return {
    flush,
    // Call after each event is queued: a full batch goes now instead of waiting for the timer.
    added() {
      if (stopped) return;
      void outbox
        .pending()
        .then((pending) => {
          if (!stopped && isFull(pending)) run();
        })
        .catch(() => {});
    },
    // Pauses every flush until timestampMs (Date.now() clock). The later time wins, so a shorter
    // pause never cuts an existing one short, and one flush runs when the pause ends. In memory
    // only; never throws.
    pauseUntil(timestampMs: number) {
      try {
        if (stopped || !Number.isFinite(timestampMs) || timestampMs <= Math.max(pausedUntil, now()))
          return;
        pausedUntil = timestampMs;
        clearTimeout(resumeTimer);
        resumeTimer = setTimeout(run, timestampMs - now());
      } catch {}
    },
    stop() {
      stopped = true;
      clearTimeout(resumeTimer);
      clearInterval(timer);
      stopHidden();
      stopOnline();
    },
  };
}
