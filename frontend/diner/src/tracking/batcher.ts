// Groups outbox events into small batches and hands them to the sender (S3-TRK-01.2). Limits follow
// the ingestion contract (ObservationBatchV2Schema, PR #70; confirmed by Zhiliang): 1 to 25 events
// and at most 32,768 bytes for the whole JSON request body, both at once. Flushes on a timer and when the page is hidden or closed; waits while offline and
// releases on reconnect. Events leave the outbox only when the sender reports them handled, so a
// failure keeps them for the next try. Sending itself, receipts and retries are TRK-01.3.
import type { Envelope } from './envelope';
import type { Outbox } from './outbox';

export const BATCH_MAX_ITEMS = 25;
export const BATCH_MAX_BYTES = 32 * 1024;
export const FLUSH_EVERY_MS = 10_000;

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

export function createBatcher(
  outbox: Outbox,
  { deliver, triggers }: { deliver: Deliver; triggers: BatchTriggers },
) {
  let flushing = false;

  async function flush() {
    if (flushing || !triggers.isOnline()) return;
    const batch = nextBatch(outbox.pending());
    if (batch.length === 0) return;
    flushing = true;
    try {
      const handled = await deliver(batch);
      await outbox.remove(handled);
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
    stop() {
      clearInterval(timer);
      stopHidden();
      stopOnline();
    },
  };
}
