// The shared tracking layer (S3-TRK-01). Screens call track(eventName, payload) with the event's
// payload fields plus publication_revision_id; the layer checks the name, builds the observation.v2
// envelope (identity, sequence, publication) and queues it. A tracking failure never breaks
// browsing, Save or Compare.
//
// Modes (S3-TRK-01.2):
// - Fixture (the default, until a live published menu enables live mode): ignores the consent gate,
//   keeps events in memory only and logs each event and each would-be batch to the console, labelled
//   as a test. Nothing is sent and nothing is stored, and nothing goes to PostHog, so fixture events
//   can never be sent later.
// - Live: only when the consent gate allows it (off by default; see consent.ts) is an event
//   delivered, independently, to the canonical outbox (POST /observations, sent by TRK-01.3) and to
//   PostHog through Jeffin's adapter, connected by connectPostHogFromEnv (Sai with Vivien, 3 Nov).
import type { AnalyticsEnvironment } from '@peekaplate/analytics';
import type { P0EventName } from '@peekaplate/analytics/event-names';
import { createPostHogAdapter, type PostHogSdk } from '@peekaplate/analytics/posthog';
import { browserBatchTriggers, createBatcher, type Deliver } from './batcher';
import { isTrackingAllowed, onTrackingAllowedChange, readPrivacySignal } from './consent';
import { buildEnvelope, type Envelope } from './envelope';
import { browserLifecycle, browserSessionStore, createIdentity, type Identity } from './identity';
import { browserOutboxStore, createOutbox, memoryOutboxStore, type OutboxStore } from './outbox';
import { clearPendingWithdrawal, hasPendingWithdrawal, markWithdrawal } from './withdrawal';

export { startOpeningClock } from './activity-clock';
export type { Deliver } from './batcher';
export {
  browserPrivacySignal,
  isTrackingAllowed,
  onTrackingAllowedChange,
  setPrivacySignal,
  setTrackingAllowed,
} from './consent';
export { newComparisonId, newExposureId, newOpeningId } from './ids';

export type TrackPayload = Record<string, unknown>;

const TEST_EVENT_LABEL = '[track] test event (fixture mode, not sent)';
const TEST_BATCH_LABEL = '[track] test batch (fixture mode, not sent)';

const devWarn = (message: string, detail?: string) => {
  if (import.meta.env.DEV) console.warn(`[track] ${message}`, ...(detail ? [detail] : []));
};

type Pipeline = {
  queue(envelope: Envelope): void;
  pauseUntil(timestampMs: number): void;
  clear(): Promise<void>;
};

function createPipeline(storePromise: Promise<OutboxStore>, deliver: Deliver): Pipeline {
  const now = () => Date.now();
  let retired = false;
  let activeBatcher: ReturnType<typeof createBatcher> | undefined;
  const ready = storePromise.then(async (store) => {
    const outbox = await createOutbox(store, { now, warn: (message) => devWarn(message) });
    const batcher = createBatcher(outbox, {
      deliver: (batch) => (retired ? Promise.resolve([]) : deliver(batch)),
      triggers: browserBatchTriggers(),
    });
    activeBatcher = batcher;
    if (retired) batcher.stop();
    return { outbox, batcher };
  });
  // Adds run in order, even while the store is still opening.
  let chain: Promise<unknown> = ready;
  return {
    queue(envelope) {
      chain = chain
        .then(() => ready)
        .then(async ({ outbox, batcher }) => {
          if (retired) return;
          await outbox.add(envelope, () => !retired);
          if (!retired) batcher.added();
        })
        .catch(() => {});
    },
    pauseUntil(timestampMs) {
      ready.then(({ batcher }) => batcher.pauseUntil(timestampMs)).catch(() => {});
    },
    clear() {
      retired = true;
      activeBatcher?.stop();
      chain = chain.then(() => ready).then(({ outbox }) => outbox.clear());
      return chain.then(() => {});
    },
  };
}

// Fixture batches go only to the console (development builds only: envelopes carry session IDs
// and payloads) and count as handled.
const consoleDeliver: Deliver = async (batch) => {
  if (import.meta.env.DEV) console.info(TEST_BATCH_LABEL, batch);
  return batch.map((event) => event.event_id);
};

// Until TRK-01.3 adds delivery, live batches stay in the outbox.
const holdDeliver: Deliver = async () => [];

let mode: 'fixture' | 'live' = 'fixture';
let liveDeliver: Deliver = holdDeliver;
let identity: Identity | null = null;
const pipelines: Partial<Record<'fixture' | 'live', Pipeline>> = {};
let clearing: Promise<void> = Promise.resolve();

// For the PostHog adapter's isLive check: fixture mode never reaches PostHog.
export function isLiveTracking(): boolean {
  return mode === 'live';
}

// Withdrawal (consent withdrawn or a privacy signal) stops pending canonical sends: the live sender
// is never called while the gate is closed, and unsent events are discarded, including a batch whose
// send was in flight. Persistent deletion markers retry failed clearing across reloads. Complete
// storage failure cannot guarantee erasure (docs/posthog.md). Decided by Sai (5 Nov), matching the
// PostHog adapter, which drops its own queued events.
const WITHDRAWAL_CLEARS_QUEUE = true;
onTrackingAllowedChange((allowed) => {
  if (!allowed && WITHDRAWAL_CLEARS_QUEUE) {
    markWithdrawal();
    const old = pipelines.live;
    delete pipelines.live;
    const retired = old?.clear();
    void retired?.catch(() => {});
    clearing = clearing
      .then(async () => {
        await retired?.catch(() => {});
        await clearPendingWithdrawal();
      })
      .catch(() => {});
  } else if (allowed) resumeLiveDelivery();
});
const consentedDeliver: Deliver = async (batch) => (isTrackingAllowed() ? liveDeliver(batch) : []);

// The PostHog side of the shared dispatch. Jeffin's adapter (packages/analytics,
// createPostHogAdapter) returns exactly this shape. It gets only the event type, the validated
// payload and the event_id: never the envelope's session or producer IDs, and never the menu token.
export type PostHogSink = {
  capturePostHog(
    type: P0EventName,
    payload: Readonly<Record<string, unknown>>,
    ids: { eventId: string },
  ): void;
  setConsent(allowed: boolean): void;
};

let postHog: PostHogSink | null = null;
let stopPostHogConsent: (() => void) | null = null;

// Connects the PostHog adapter. Its consent follows this gate from now on, so the two destinations
// can never disagree. Returns a function that disconnects it.
export function connectPostHog(sink: PostHogSink): () => void {
  stopPostHogConsent?.();
  postHog = sink;
  const sync = (allowed: boolean) => {
    try {
      sink.setConsent(allowed);
    } catch {}
  };
  sync(isTrackingAllowed());
  stopPostHogConsent = onTrackingAllowedChange(sync);
  return () => {
    if (postHog !== sink) return;
    stopPostHogConsent?.();
    stopPostHogConsent = null;
    postHog = null;
  };
}

// Builds Jeffin's PostHog adapter (packages/analytics, #113) from the build's PostHog settings and
// connects it to this gate, with the same privacy signal and fixture-mode check. Does nothing unless
// PostHog is configured for this build and origin; even then the SDK downloads only after consent,
// in live mode, on the first event. Returns a function that disconnects it.
export function connectPostHogFromEnv(
  env: AnalyticsEnvironment,
  options: { origin?: string; loadSdk?: () => Promise<PostHogSdk> } = {},
): () => void {
  try {
    const adapter = createPostHogAdapter(env, {
      origin: options.origin ?? location.origin,
      privacySignal: readPrivacySignal,
      isLive: isLiveTracking,
      ...(options.loadSdk ? { loadSdk: options.loadSdk } : {}),
    });
    if (!adapter.configured) return () => {};
    return connectPostHog(adapter);
  } catch {
    // PostHog must never break browsing.
    return () => {};
  }
}

// Exactly once per track() call, after validation and consent. Canonical retries, receipts and the
// Queue never come back here, so they can never send to PostHog again. A PostHog failure never
// reaches the canonical path or the screens.
function captureToPostHog(envelope: Envelope) {
  try {
    postHog?.capturePostHog(envelope.type, envelope.payload, { eventId: envelope.event_id });
  } catch {}
}

// Called once a live published menu is loaded (DIN-03) and, in TRK-01.3, with the token-bound
// sender. Fixture builds never call it, so they never send.
export function enableLiveTracking(deliver: Deliver = holdDeliver): void {
  mode = 'live';
  liveDeliver = deliver;
  resumeLiveDelivery();
}

// Opens the durable outbox once live tracking is on and allowed, so events kept from an earlier
// page (for example after a failed send and a reload) are sent without waiting for a new event.
// Everything stored was collected with consent: withdrawal empties the outbox.
function resumeLiveDelivery(): void {
  try {
    if (mode === 'live' && isTrackingAllowed()) pipeline();
  } catch {}
}

// For TRK-01.3 delivery: after a failed send, pause live delivery until timestampMs (Date.now()
// clock), e.g. Date.now() + retryDelayMs(attempt, retryAfterMs). The later time wins, one flush
// runs when it ends, it is in memory only and never throws. Fixture mode never sends, so it is a
// no-op there, as it is before any live event has been queued.
export function pauseDeliveryUntil(timestampMs: number): void {
  try {
    if (mode === 'live') pipelines.live?.pauseUntil(timestampMs);
  } catch {}
}

function pipeline(): Pipeline {
  if (mode === 'fixture') {
    pipelines.fixture ??= createPipeline(Promise.resolve(memoryOutboxStore()), consoleDeliver);
    return pipelines.fixture;
  }
  pipelines.live ??= createPipeline(
    clearing.then(async () => {
      if (hasPendingWithdrawal()) {
        try {
          await clearPendingWithdrawal();
        } catch {
          // New work stays in memory rather than reopening records whose withdrawal failed.
          return memoryOutboxStore();
        }
        if (hasPendingWithdrawal()) return memoryOutboxStore();
      }
      return browserOutboxStore();
    }),
    consentedDeliver,
  );
  return pipelines.live;
}

export function track(eventName: string, payload: TrackPayload): void {
  try {
    // Live events need consent before anything happens, so a declined event uses no sequence number.
    if (mode === 'live' && !isTrackingAllowed()) return;
    const now = () => Date.now();
    const uuid = () => crypto.randomUUID();
    identity ??= createIdentity({
      store: browserSessionStore(),
      uuid,
      now,
      lifecycle: browserLifecycle(),
    });
    const envelope = buildEnvelope(eventName, payload, { identity, now, uuid });
    if (!envelope) {
      // The name only: payloads can contain dish IDs and are never logged on rejection.
      devWarn('dropped an invalid event:', eventName);
      return;
    }
    if (mode === 'fixture') {
      if (import.meta.env.DEV) console.info(TEST_EVENT_LABEL, envelope);
      pipeline().queue(envelope);
      return;
    }
    // Live: the two destinations are independent; neither can stop the other.
    pipeline().queue(envelope);
    captureToPostHog(envelope);
  } catch {
    // Fire-and-forget: a tracking failure must never break browsing, Save or Compare.
  }
}
