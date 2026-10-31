// Delivery of queued observation.v2 events (S3-TRK-01.3; ADR 0015; matrix v0.1h §7). Sends a batch
// to POST /observations with the menu token in the Authorization header only, reads the per-event
// receipts and says which events leave the outbox and which stay for a retry. The outbox, batching
// and flush timing belong to TRK-01.2; this module never stores, logs or relabels anything.

// Request limits (matrix v0.1h §7): at most 25 events and 32 KiB per request.
export const MAX_BATCH_EVENTS = 25;
export const MAX_BATCH_BYTES = 32 * 1024;
// Retry backoff starts at 1 second, doubles and is capped at 60 seconds.
export const RETRY_BASE_MS = 1_000;
export const RETRY_CAP_MS = 60_000;

export type MenuToken = Readonly<{ value: string; expiresAt: number }>;

// The envelope from TRK-01.1, frozen at track() time, so a retry resends the same event_id and
// payload. Only event_id is read here.
export type QueuedEnvelope = Readonly<{ event_id: string } & Record<string, unknown>>;

// Each queued event keeps the token it was issued under, so it is never sent with another one and
// is dropped once that token expires (no relabelling after a publication or token change).
export type QueuedEvent = Readonly<{ envelope: QueuedEnvelope; token: MenuToken }>;

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
  counts: TerminalCounts;
};

export type DeliveryOptions = {
  endpoint: string;
  fetch: typeof globalThis.fetch;
  now: () => number;
};

type Receipt = { event_id: string | null; status: string; retryable: boolean };

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

function requestBody(batch: QueuedEvent[]): string {
  return JSON.stringify({ contract: 'observation.v2', events: batch.map((e) => e.envelope) });
}

function bodyBytes(body: string): number {
  return new TextEncoder().encode(body).length;
}

// Receipts come back in request order, one per event (observation-receipt.v1). Anything else is
// an uncertain answer, so the whole batch is retried rather than guessed at.
function readReceipts(body: unknown, batch: QueuedEvent[]): Receipt[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const { contract, receipts } = body as Record<string, unknown>;
  if (contract !== 'observation-receipt.v1' || !Array.isArray(receipts)) return null;
  if (receipts.length !== batch.length) return null;
  const valid = receipts.every((r, i) => {
    if (typeof r !== 'object' || r === null) return false;
    const { event_id: id, status } = r as Record<string, unknown>;
    const idMatches = id === batch[i]?.envelope.event_id || (id === null && status === 'rejected');
    return idMatches && (status === 'accepted' || status === 'retry' || status === 'rejected');
  });
  return valid ? (receipts as Receipt[]) : null;
}

function retryAfterMs(response: Response): number | null {
  const seconds = Number(response.headers.get('Retry-After'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

function splitInHalf(batch: QueuedEvent[]): [QueuedEvent[], QueuedEvent[]] {
  const middle = Math.ceil(batch.length / 2);
  return [batch.slice(0, middle), batch.slice(middle)];
}

// Sends one batch that shares a token. Too-large batches are halved down to single events (413).
async function sendBatch(
  batch: QueuedEvent[],
  token: MenuToken,
  options: DeliveryOptions,
  result: DeliveryResult,
): Promise<void> {
  const ids = batch.map((e) => e.envelope.event_id);
  const body = requestBody(batch);

  if (batch.length > MAX_BATCH_EVENTS || bodyBytes(body) > MAX_BATCH_BYTES) {
    return splitOrDropOversized(batch, token, options, result);
  }

  let response: Response;
  try {
    response = await options.fetch(options.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token.value}`, 'Content-Type': 'application/json' },
      body,
    });
  } catch {
    // Offline or the request never completed: the outcome is unknown, so keep everything.
    result.retry.push(...ids);
    return;
  }

  if (response.status === 200) {
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {}
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

  if (response.status === 413) return splitOrDropOversized(batch, token, options, result);

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
    const wait = retryAfterMs(response);
    if (wait !== null) result.retryAfterMs = Math.max(result.retryAfterMs ?? 0, wait);
  }
  // 429, 503 and anything unexpected: nothing was accepted, so keep the batch as it is.
  result.retry.push(...ids);
}

async function splitOrDropOversized(
  batch: QueuedEvent[],
  token: MenuToken,
  options: DeliveryOptions,
  result: DeliveryResult,
): Promise<void> {
  if (batch.length === 1) {
    // A single event that is still too large leaves the queue (payload_too_large).
    result.done.push(batch[0]?.envelope.event_id as string);
    result.counts.payloadTooLarge++;
    return;
  }
  for (const half of splitInHalf(batch)) await sendBatch(half, token, options, result);
}

// Sends the given queued events. Events whose token has expired are dropped without a request;
// the rest are grouped by token so each request carries only the token its events were issued
// under.
export async function deliver(
  events: readonly QueuedEvent[],
  options: DeliveryOptions,
): Promise<DeliveryResult> {
  const result: DeliveryResult = { done: [], retry: [], retryAfterMs: null, counts: emptyCounts() };
  const byToken = new Map<string, { token: MenuToken; events: QueuedEvent[] }>();

  for (const event of events) {
    if (options.now() >= event.token.expiresAt) {
      result.done.push(event.envelope.event_id);
      result.counts.expired++;
      continue;
    }
    const group = byToken.get(event.token.value) ?? { token: event.token, events: [] };
    group.events.push(event);
    byToken.set(event.token.value, group);
  }

  for (const { token, events: batch } of byToken.values()) {
    for (let start = 0; start < batch.length; start += MAX_BATCH_EVENTS) {
      await sendBatch(batch.slice(start, start + MAX_BATCH_EVENTS), token, options, result);
    }
  }
  return result;
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
