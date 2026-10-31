// Turns a track() call into an observation.v2 envelope (S3-TRK-01.1). Callers pass the event's
// payload fields plus publication_revision_id; the layer lifts publication_revision_id into the
// envelope (agreed with Jeffin) and adds the rest. Validation runs before a sequence number is
// assigned, so a dropped event never uses one (Zhiliang). Clients never send venue authority.
import { isAllowedEvent, type P0EventName } from './event-names';
import type { Identity } from './identity';

export const SCHEMA_VERSION = 'observation.v2';

export type Envelope = Readonly<{
  schema_version: typeof SCHEMA_VERSION;
  event_id: string;
  type: P0EventName;
  session_id: string;
  producer_id: string;
  local_sequence: number;
  occurred_at: string;
  publication_revision_id: string;
  payload: Readonly<Record<string, unknown>>;
}>;

// Strict per-event payload validation plugs in here. The observation.v2 schema (PR #40) is written
// with zod, which the diner does not depend on yet, so the default only checks the shape.
export type PayloadValidator = (type: P0EventName, payload: Record<string, unknown>) => boolean;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype
  );
}

export function buildEnvelope(
  name: string,
  input: unknown,
  {
    identity,
    now,
    uuid,
    validate = () => true,
  }: { identity: Identity; now: () => number; uuid: () => string; validate?: PayloadValidator },
): Envelope | null {
  if (!isAllowedEvent(name) || !isPlainObject(input)) return null;
  const { publication_revision_id: publicationRevisionId, ...payload } = input;
  if (typeof publicationRevisionId !== 'string' || publicationRevisionId === '') return null;
  if (!validate(name, payload)) return null;

  const { sessionId, producerId, localSequence } = identity.next();
  // Frozen so a retry can only ever resend the same event_id and payload.
  return Object.freeze({
    schema_version: SCHEMA_VERSION,
    event_id: uuid(),
    type: name,
    session_id: sessionId,
    producer_id: producerId,
    local_sequence: localSequence,
    occurred_at: new Date(now()).toISOString(),
    publication_revision_id: publicationRevisionId,
    payload: Object.freeze(payload),
  });
}
