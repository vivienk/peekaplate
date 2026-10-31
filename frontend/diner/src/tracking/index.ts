// The shared tracking layer (S3-TRK-01). Screens call track(eventName, payload) with the event's
// payload fields plus publication_revision_id; the layer checks the name, builds the observation.v2
// envelope (identity, sequence, publication) and hands it on. Consent, the outbox and delivery
// (TRK-01.2/.3) come next behind this same signature; until then envelopes are only logged, so
// nothing leaves the browser. A tracking failure never breaks browsing, Save or Compare.
import { buildEnvelope, type Envelope } from './envelope';
import { browserLifecycle, browserSessionStore, createIdentity } from './identity';

export { startOpeningClock } from './activity-clock';
export { newComparisonId, newExposureId, newOpeningId } from './ids';

export type TrackPayload = Record<string, unknown>;

type Tracker = (eventName: string, payload: TrackPayload) => void;

function createTracker(): Tracker {
  const now = () => Date.now();
  const uuid = () => crypto.randomUUID();
  const identity = createIdentity({
    store: browserSessionStore(),
    uuid,
    now,
    lifecycle: browserLifecycle(),
  });
  const output = (envelope: Envelope) => console.info('[track]', envelope);
  return (eventName, payload) => {
    const envelope = buildEnvelope(eventName, payload, { identity, now, uuid });
    if (envelope) {
      output(envelope);
    } else if (import.meta.env.DEV) {
      // The name only: payloads can contain dish IDs and are never logged on rejection.
      console.warn('[track] dropped an invalid event:', eventName);
    }
  };
}

let tracker: Tracker | null = null;

export function track(eventName: string, payload: TrackPayload): void {
  try {
    tracker ??= createTracker();
    tracker(eventName, payload);
  } catch {
    // Fire-and-forget: a tracking failure must never break browsing, Save or Compare.
  }
}
