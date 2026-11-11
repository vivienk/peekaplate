// Delivery of queued observation.v2 events (S3-TRK-01.3; ADR 0015; matrix v0.1h §7). Sends a batch
// to POST /observations with the menu token in the Authorization header only, reads the per-event
// receipts and says which events leave the outbox and which stay for a retry. The outbox, batching
// and flush timing belong to TRK-01.2. This module never stores or relabels anything; development
// builds log only aggregate terminal counts, never event contents or the token.
import { type ObservationReceipt, ObservationReceiptBatchSchema } from '@peekaplate/contracts';
import { BATCH_MAX_BYTES, BATCH_MAX_ITEMS, batchBody, type Deliver } from './batcher';
import { isTrackingAllowed, onTrackingAllowedChange } from './consent';
import type { Envelope } from './envelope';
import { pauseDeliveryUntil } from './index';

// Request limits (matrix v0.1h §7; ObservationBatchV2Schema): one shared source with the TRK-01.2
// batcher, so the batches it builds and the ones sent here are always measured the same way.
export const MAX_BATCH_EVENTS = BATCH_MAX_ITEMS;
export const MAX_BATCH_BYTES = BATCH_MAX_BYTES;
// Retry backoff starts at 1 second, doubles and is capped at 60 seconds.
export const RETRY_BASE_MS = 1_000;
export const RETRY_CAP_MS = 60_000;
export const REQUEST_TIMEOUT_MS = 10_000;

// The token from the current menu response (RES-02): held in memory for the visit only, never
// stored in the outbox, so it never outlives the visit.
export type MenuToken = Readonly<{
  value: string;
  expiresAt: number;
  publicationRevisionId: string;
}>;

// The envelope from TRK-01.1, frozen at track() time, so a retry resends the same event_id and
// payload. Only event_id and publication_revision_id are read here.
export type QueuedEnvelope = Readonly<
  { event_id: string; publication_revision_id: string } & Record<string, unknown>
>;

// Aggregate terminal counts for the local development log; never event contents or tokens.
export type TerminalCounts = {
  accepted: number;
  rejected: number;
  expired: number;
  unauthorized: number;
  clientInvalid: number;
  payloadTooLarge: number;
};

export type DeliveryResult = {
  // event_ids that leave the outbox: delivered, rejected for good, or expired.
  done: string[];
  // event_ids that stay queued and are retried later with the same event_id and payload.
  retry: string[];
  // Server-requested wait from Retry-After (429), when given.
  retryAfterMs: number | null;
  // HTTP requests made. Zero means nothing reached the network (no token yet, or every event was
  // dropped unsent), so a retry left over is not a failed send.
  requests: number;
  counts: TerminalCounts;
};

export type DeliveryOptions = {
  endpoint: string;
  fetch: typeof globalThis.fetch;
  now: () => number;
  // The current menu token, or null before a menu with a token has loaded.
  token: () => MenuToken | null;
  // Rechecked before every request, including split batches.
  canSend?: () => boolean;
};

function emptyCounts(): TerminalCounts {
  return {
    accepted: 0,
    rejected: 0,
    expired: 0,
    unauthorized: 0,
    clientInvalid: 0,
    payloadTooLarge: 0,
  };
}

// The same wrapper the batcher measures, so a batch it built never fails the size check here.
function requestBody(batch: QueuedEnvelope[]): string {
  return JSON.stringify(batchBody(batch as unknown as Envelope[]));
}

function bodyBytes(body: string): number {
  return new TextEncoder().encode(body).length;
}

// Receipts come back in request order, one per event (observation-receipt.v1). Anything else is
// an uncertain answer, so the whole batch is retried rather than guessed at.
function readReceipts(body: unknown, batch: QueuedEnvelope[]): ObservationReceipt[] | null {
  const parsed = ObservationReceiptBatchSchema.safeParse(body);
  if (!parsed.success) return null;
  const { receipts } = parsed.data;
  if (receipts.length !== batch.length) return null;
  const valid = receipts.every((r, i) => {
    const { event_id: id, status } = r;
    const idMatches = id === batch[i]?.event_id || (id === null && status === 'rejected');
    return idMatches && (status === 'accepted' || status === 'retry' || status === 'rejected');
  });
  return valid ? receipts : null;
}

function retryAfterMs(response: Response, now: number): number | null {
  const header = response.headers.get('Retry-After');
  if (!header) return null;
  const milliseconds = /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - now;
  return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : null;
}

function splitInHalf(batch: QueuedEnvelope[]): [QueuedEnvelope[], QueuedEnvelope[]] {
  const middle = Math.ceil(batch.length / 2);
  return [batch.slice(0, middle), batch.slice(middle)];
}

// Sends one batch. Too-large batches are halved down to single events (413).
async function sendBatch(
  batch: QueuedEnvelope[],
  options: DeliveryOptions,
  result: DeliveryResult,
): Promise<void> {
  const ids = batch.map((e) => e.event_id);
  if (result.retry.length > 0 || options.canSend?.() === false) {
    result.retry.push(...ids);
    return;
  }
  const token = options.token();
  if (!token) {
    result.retry.push(...ids);
    return;
  }
  if (
    options.now() >= token.expiresAt ||
    batch.some((event) => event.publication_revision_id !== token.publicationRevisionId)
  ) {
    result.done.push(...ids);
    result.counts.expired += ids.length;
    return;
  }
  const body = requestBody(batch);

  if (batch.length > MAX_BATCH_EVENTS || bodyBytes(body) > MAX_BATCH_BYTES) {
    return splitOrDropOversized(batch, options, result);
  }

  let response: Response;
  result.requests++;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let parsed: unknown = null;
  try {
    response = await options.fetch(options.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token.value}`, 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
      credentials: 'omit',
      redirect: 'error',
    });
    if (response.status === 200) parsed = await response.json();
  } catch {
    // Offline or the request never completed: the outcome is unknown, so keep everything.
    result.retry.push(...ids);
    return;
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 200) {
    const receipts = readReceipts(parsed, batch);
    if (!receipts) {
      result.retry.push(...ids);
      return;
    }
    receipts.forEach((receipt, i) => {
      const id = ids[i] as string;
      if (receipt.status === 'retry') {
        result.retry.push(id);
        return;
      }
      result.done.push(id);
      if (receipt.status === 'accepted') result.counts.accepted++;
      else result.counts.rejected++;
    });
    return;
  }

  if (response.status === 413) return splitOrDropOversized(batch, options, result);

  if (response.status === 400) {
    // An unreadable envelope is never resent (client_invalid).
    result.done.push(...ids);
    result.counts.clientInvalid += ids.length;
    return;
  }

  if (response.status === 401 || response.status === 403) {
    // The token itself was refused; these events cannot be sent under any other token.
    result.done.push(...ids);
    result.counts.unauthorized += ids.length;
    return;
  }

  if (response.status === 429) {
    const wait = retryAfterMs(response, options.now());
    if (wait !== null) result.retryAfterMs = Math.max(result.retryAfterMs ?? 0, wait);
  }
  // 429, 503 and anything unexpected: nothing was accepted, so keep the batch as it is.
  result.retry.push(...ids);
}

async function splitOrDropOversized(
  batch: QueuedEnvelope[],
  options: DeliveryOptions,
  result: DeliveryResult,
): Promise<void> {
  if (batch.length === 1) {
    // A single event that is still too large leaves the queue (payload_too_large).
    result.done.push(batch[0]?.event_id as string);
    result.counts.payloadTooLarge++;
    return;
  }
  for (const half of splitInHalf(batch)) await sendBatch(half, options, result);
}

// Sends the given queued events with the current menu token. An event is sent only under a valid
// token for its own publication, so it is never relabelled: after a publication change or once the
// token has expired, it is dropped without a request and counted. With no token yet, nothing is
// sent and everything waits.
export async function deliver(
  events: readonly QueuedEnvelope[],
  options: DeliveryOptions,
): Promise<DeliveryResult> {
  const result: DeliveryResult = {
    done: [],
    retry: [],
    retryAfterMs: null,
    requests: 0,
    counts: emptyCounts(),
  };
  const token = options.token();
  if (!token) {
    result.retry.push(...events.map((e) => e.event_id));
    return result;
  }

  const tokenValid = options.now() < token.expiresAt;
  const sendable: QueuedEnvelope[] = [];
  for (const event of events) {
    if (tokenValid && event.publication_revision_id === token.publicationRevisionId) {
      sendable.push(event);
    } else {
      result.done.push(event.event_id);
      result.counts.expired++;
    }
  }

  for (let start = 0; start < sendable.length; start += MAX_BATCH_EVENTS) {
    await sendBatch(sendable.slice(start, start + MAX_BATCH_EVENTS), options, result);
  }
  return result;
}

// The sender the TRK-01.2 batcher calls: it resolves to the event_ids that leave the outbox.
// `onResult` gets the full result, for Retry-After backoff and the dev log of terminal counts.
export function createDeliver(
  options: DeliveryOptions,
  onResult?: (result: DeliveryResult) => void,
): (batch: readonly QueuedEnvelope[]) => Promise<string[]> {
  return async (batch) => {
    const result = await deliver(batch, options);
    try {
      onResult?.(result);
    } catch {}
    return result.done;
  };
}

// Wait before the next attempt: doubling from 1 second, capped at 60 seconds, never shorter than
// a server Retry-After. `random` adds jitter so many tabs do not retry in step.
export function retryDelayMs(
  attempt: number,
  retryAfter: number | null = null,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1));
  const jittered = Math.round(exponential / 2 + (exponential / 2) * random());
  return Math.max(jittered, retryAfter ?? 0);
}

export type RetryPauseOptions = {
  // Pauses every batcher trigger until the given Date.now() time; defaults to the shared layer's.
  pause?: (timestampMs: number) => void;
  now?: () => number;
  random?: () => number;
};

// The onResult handler that backs delivery off (agreed with Nifemi and Jeffin, 3 Nov). After a send
// that left events to retry (offline, 503, 429, unreadable answer or a retry receipt) it pauses the
// batcher for retryDelayMs(attempt, Retry-After), so the timer, page-hide and reconnect triggers
// cannot retry early and a 429 is honoured. The attempt count grows with each failed send and
// resets once a send leaves nothing to retry. A result with no request (no token yet) is not a
// failure and changes nothing. In memory only, per tab; never throws.
export function createRetryPause({
  pause = pauseDeliveryUntil,
  now = () => Date.now(),
  random = Math.random,
}: RetryPauseOptions = {}): (result: DeliveryResult) => void {
  let attempt = 0;
  return (result) => {
    try {
      if (result.requests === 0) return;
      if (result.retry.length === 0) {
        attempt = 0;
        return;
      }
      attempt++;
      pause(now() + retryDelayMs(attempt, result.retryAfterMs, random));
    } catch {}
  };
}

const DEV_LOG_LABEL = '[track] delivery counts';

// The local development log (AC 6): counts of events that left the outbox, by outcome, including
// those discarded unsent after a publication change or token expiry. Counts only: never event_ids,
// payloads, session IDs or the token. Silent in production builds and when nothing ended.
export function logTerminalCounts(
  result: DeliveryResult,
  log: (label: string, counts: TerminalCounts) => void = (label, counts) => {
    if (import.meta.env.DEV) console.info(label, counts);
  },
): void {
  if (Object.values(result.counts).some((n) => n > 0)) log(DEV_LOG_LABEL, { ...result.counts });
}

export type LiveDeliverOptions = RetryPauseOptions & {
  // Replaces the development log of terminal counts (for tests).
  log?: (label: string, counts: TerminalCounts) => void;
  onResult?: (result: DeliveryResult) => void;
};

// The live sender for enableLiveTracking(): token-bound delivery with the retry pause and the
// development log of terminal counts wired in. `onResult` still sees every result.
export function createLiveDeliver(
  options: DeliveryOptions,
  { onResult, log, ...pauseOptions }: LiveDeliverOptions = {},
): Deliver {
  const backOff = createRetryPause(pauseOptions);
  return async (batch) => {
    let withdrawn = false;
    const stop = onTrackingAllowedChange((allowed) => {
      if (!allowed) withdrawn = true;
    });
    try {
      return await createDeliver(
        {
          ...options,
          canSend: () => !withdrawn && isTrackingAllowed() && options.canSend?.() !== false,
        },
        (result) => {
          backOff(result);
          logTerminalCounts(result, log);
          onResult?.(result);
        },
      )(batch);
    } finally {
      stop();
    }
  };
}
