// The shared tracking layer (S3-TRK-01). Screens call track(eventName, payload) with the event's
// payload fields plus publication_revision_id; the layer checks the name, builds the observation.v2
// envelope (identity, sequence, publication) and queues it. A tracking failure never breaks
// browsing, Save or Compare.
//
// Modes (S3-TRK-01.2):
// - Fixture (the default, until a live published menu enables live mode): ignores the consent gate,
//   keeps events in memory only and logs each event and each would-be batch to the console, labelled
//   as a test. Nothing is sent and nothing is stored, so fixture events can never be sent later.
// - Live: only when the consent gate allows it (off by default) is an event queued in the durable
//   outbox and batched. Sending, receipts and retries are TRK-01.3; until then nothing is sent.
import { browserBatchTriggers, createBatcher, type Deliver } from './batcher';
import { isTrackingAllowed } from './consent';
import { buildEnvelope, type Envelope } from './envelope';
import { browserLifecycle, browserSessionStore, createIdentity, type Identity } from './identity';
import { browserOutboxStore, createOutbox, memoryOutboxStore, type OutboxStore } from './outbox';

export { startOpeningClock } from './activity-clock';
export type { Deliver } from './batcher';
export { isTrackingAllowed, setTrackingAllowed } from './consent';
export { newComparisonId, newExposureId, newOpeningId } from './ids';

export type TrackPayload = Record<string, unknown>;

const TEST_EVENT_LABEL = '[track] test event (fixture mode, not sent)';
const TEST_BATCH_LABEL = '[track] test batch (fixture mode, not sent)';

const devWarn = (message: string, detail?: string) => {
  if (import.meta.env.DEV) console.warn(`[track] ${message}`, ...(detail ? [detail] : []));
};

type Pipeline = { queue(envelope: Envelope): void };

function createPipeline(storePromise: Promise<OutboxStore>, deliver: Deliver): Pipeline {
  const now = () => Date.now();
  const ready = storePromise.then(async (store) => {
    const outbox = await createOutbox(store, { now, warn: (message) => devWarn(message) });
    createBatcher(outbox, { deliver, triggers: browserBatchTriggers() });
    return outbox;
  });
  // Adds run in order, even while the store is still opening.
  let chain: Promise<unknown> = ready;
  return {
    queue(envelope) {
      chain = chain
        .then(() => ready)
        .then((outbox) => outbox.add(envelope))
        .catch(() => {});
    },
  };
}

// Fixture batches go only to the console and count as handled.
const consoleDeliver: Deliver = async (batch) => {
  console.info(TEST_BATCH_LABEL, batch);
  return batch.map((event) => event.event_id);
};

// Until TRK-01.3 adds delivery, live batches stay in the outbox.
const holdDeliver: Deliver = async () => [];

let mode: 'fixture' | 'live' = 'fixture';
let liveDeliver: Deliver = holdDeliver;
let identity: Identity | null = null;
const pipelines: Partial<Record<'fixture' | 'live', Pipeline>> = {};

// Called once a live published menu is loaded (DIN-03) and, in TRK-01.3, with the token-bound
// sender. Fixture builds never call it, so they never send.
export function enableLiveTracking(deliver: Deliver = holdDeliver): void {
  mode = 'live';
  liveDeliver = deliver;
}

function pipeline(): Pipeline {
  if (mode === 'fixture') {
    pipelines.fixture ??= createPipeline(Promise.resolve(memoryOutboxStore()), consoleDeliver);
    return pipelines.fixture;
  }
  pipelines.live ??= createPipeline(browserOutboxStore(), (batch) => liveDeliver(batch));
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
    if (mode === 'fixture') console.info(TEST_EVENT_LABEL, envelope);
    pipeline().queue(envelope);
  } catch {
    // Fire-and-forget: a tracking failure must never break browsing, Save or Compare.
  }
}
